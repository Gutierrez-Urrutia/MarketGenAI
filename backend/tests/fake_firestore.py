"""In-memory stand-in for the async Firestore client, enough for the real
repositories of firestore_service (create / get / list / update and
transactions). Synthetic data only; no network.

Use `use_fake_firestore()` as a context manager: it points `get_db()` at a
FakeDB and replaces `firestore.async_transactional` with a decorator that
runs the function once and then commits its buffered writes — like a real
transaction without contention. Every committed write is logged in
`db.writes` as (collection, doc_id, data), so a test can assert that a
refused transaction wrote nothing.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from google.cloud import firestore
from google.cloud.firestore_v1.transforms import ArrayUnion

import app.services.firestore_service as fs


def _get_path(doc: Dict[str, Any], path: str) -> Any:
    value: Any = doc
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _apply_update(doc: Dict[str, Any], data: Dict[str, Any]) -> None:
    for key, value in data.items():
        if value is firestore.DELETE_FIELD:
            doc.pop(key, None)
        elif isinstance(value, ArrayUnion):
            current = list(doc.get(key) or [])
            current.extend(v for v in value.values if v not in current)
            doc[key] = current
        else:
            doc[key] = copy.deepcopy(value)


class FakeSnap:
    def __init__(self, doc_id: str, data: Optional[Dict[str, Any]]):
        self.id = doc_id
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> Optional[Dict[str, Any]]:
        return copy.deepcopy(self._data)


class FakeDocRef:
    def __init__(self, db: "FakeDB", collection: str, doc_id: str):
        self.db, self.collection, self.id = db, collection, doc_id

    @property
    def _store(self) -> Dict[str, Dict[str, Any]]:
        return self.db.data.setdefault(self.collection, {})

    async def get(self, transaction=None) -> FakeSnap:
        if transaction is not None:
            transaction.reads += 1
        return FakeSnap(self.id, self._store.get(self.id))

    async def set(self, data: Dict[str, Any]) -> None:
        self.db.commit_write(self, data, replace=True)

    async def update(self, data: Dict[str, Any]) -> None:
        self.db.commit_write(self, data, replace=False)

    async def delete(self) -> None:
        self._store.pop(self.id, None)


class FakeQuery:
    def __init__(self, db: "FakeDB", collection: str):
        self.db, self.collection = db, collection
        self.filters: List[Any] = []
        self.order: Optional[tuple] = None
        self._limit: Optional[int] = None

    def where(self, filter=None):  # noqa: A002 — Firestore's keyword
        query = copy.copy(self)
        query.filters = [*self.filters, filter]
        return query

    def order_by(self, field: str, direction=None):
        query = copy.copy(self)
        query.order = (field, direction)
        return query

    def limit(self, n: int):
        query = copy.copy(self)
        query._limit = n
        return query

    def offset(self, n: int):
        return self

    def document(self, doc_id: str) -> FakeDocRef:
        return FakeDocRef(self.db, self.collection, doc_id)

    async def get(self) -> List[FakeSnap]:
        self.db.queries.append((self.collection, [(f.field_path, f.op_string, f.value) for f in self.filters], self.order))
        docs = list(self.db.data.get(self.collection, {}).items())
        for f in self.filters:
            assert f.op_string == "==", "the repositories under test only use equality filters"
            docs = [(i, d) for i, d in docs if _get_path(d, f.field_path) == f.value]
        if self.order:
            field, direction = self.order
            docs.sort(key=lambda item: item[1].get(field), reverse=direction == firestore.Query.DESCENDING)
        if self._limit:
            docs = docs[: self._limit]
        return [FakeSnap(i, d) for i, d in docs]


class FakeTransaction:
    def __init__(self, db: "FakeDB"):
        self.db = db
        self.pending: List[tuple] = []
        self.reads = 0

    def update(self, ref: FakeDocRef, data: Dict[str, Any]) -> None:
        self.pending.append((ref, data, False))

    def set(self, ref: FakeDocRef, data: Dict[str, Any]) -> None:
        self.pending.append((ref, data, True))

    def commit(self) -> None:
        for ref, data, replace in self.pending:
            self.db.commit_write(ref, data, replace=replace)


class FakeDB:
    def __init__(self):
        self.data: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.writes: List[tuple] = []
        self.queries: List[tuple] = []
        self.transactions: List[FakeTransaction] = []

    def collection(self, name: str) -> FakeQuery:
        return FakeQuery(self, name)

    def transaction(self) -> FakeTransaction:
        txn = FakeTransaction(self)
        self.transactions.append(txn)
        return txn

    def commit_write(self, ref: FakeDocRef, data: Dict[str, Any], replace: bool) -> None:
        store = ref._store
        if replace:
            store[ref.id] = {}
        elif ref.id not in store:
            raise KeyError(f"{ref.collection}/{ref.id} does not exist")
        _apply_update(store[ref.id], data)
        self.writes.append((ref.collection, ref.id, data))

    # helpers for tests
    def put(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        self.data.setdefault(collection, {})[doc_id] = copy.deepcopy({"id": doc_id, **data})

    def doc(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        return copy.deepcopy(self.data.get(collection, {}).get(doc_id))

    def writes_to(self, collection: str) -> List[tuple]:
        return [w for w in self.writes if w[0] == collection]


def _fake_transactional(fn):
    async def run(txn: FakeTransaction, *args, **kwargs):
        result = await fn(txn, *args, **kwargs)
        txn.commit()
        return result

    return run


@contextmanager
def use_fake_firestore():
    db = FakeDB()
    with (
        patch.object(fs, "get_db", return_value=db),
        patch.object(fs.firestore, "async_transactional", _fake_transactional),
    ):
        yield db
