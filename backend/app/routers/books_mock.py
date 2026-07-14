from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/books", tags=["Books"])

books_db = [
    {
        "id": 1,
        "title": "BPO Guide for Finance",
        "description": "Guía de servicios BPO para empresas financieras.",
        "status": "draft",
    }
]


class BookCreate(BaseModel):
    title: str
    description: str
    status: Optional[str] = "draft"


class BookUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


@router.get("")
def list_books():
    return books_db


@router.post("")
def create_book(book: BookCreate):
    new_book = {
        "id": len(books_db) + 1,
        "title": book.title,
        "description": book.description,
        "status": book.status,
    }
    books_db.append(new_book)
    return new_book


@router.get("/{book_id}")
def get_book(book_id: int):
    for book in books_db:
        if book["id"] == book_id:
            return book

    raise HTTPException(status_code=404, detail="Book not found")


@router.put("/{book_id}")
def update_book(book_id: int, book_update: BookUpdate):
    for book in books_db:
        if book["id"] == book_id:
            if book_update.title is not None:
                book["title"] = book_update.title
            if book_update.description is not None:
                book["description"] = book_update.description
            if book_update.status is not None:
                book["status"] = book_update.status
            return book

    raise HTTPException(status_code=404, detail="Book not found")


@router.delete("/{book_id}")
def delete_book(book_id: int):
    for index, book in enumerate(books_db):
        if book["id"] == book_id:
            deleted_book = books_db.pop(index)
            return {
                "message": "Book deleted successfully",
                "book": deleted_book,
            }

    raise HTTPException(status_code=404, detail="Book not found")