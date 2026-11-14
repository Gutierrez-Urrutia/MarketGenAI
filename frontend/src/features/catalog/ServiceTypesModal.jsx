/**
 * ServiceTypesModal — crear, renombrar y activar/desactivar tipos de servicio (RF-VTA-02).
 * Solo se abre para manager/admin. Los tipos no se borran.
 */
import { useState } from "react";
import toast from "react-hot-toast";

import { catalogApi } from "@/api/catalogApi";
import { Badge, Button, Input, Modal } from "@/components/ui";
import { serverErrorsByField } from "@/features/catalog/catalogValidation";
import { useI18n } from "@/hooks/useI18n";

export function ServiceTypesModal({ open, onClose, types, onChanged }) {
  const { t } = useI18n();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState({ id: null, message: "" });
  const [busy, setBusy] = useState(false);

  const run = async (id, action) => {
    setBusy(true);
    setError({ id: null, message: "" });
    try {
      await action();
      onChanged();
      return true;
    } catch (err) {
      const mapped = serverErrorsByField(err);
      const message = mapped.name || mapped._form || (Array.isArray(err?.response?.data?.detail) ? err.response.data.detail[0]?.msg : null);
      if (err?.response?.status === 403) toast.error(t("catalogPage.forbidden"));
      setError({ id, message: message || t("catalogPage.genericError") });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (event) => {
    event.preventDefault();
    if (!newName.trim()) {
      setError({ id: "new", message: t("catalogPage.errors.required") });
      return;
    }
    const ok = await run("new", () => catalogApi.createServiceType({ name: newName.trim() }));
    if (ok) setNewName("");
  };

  const saveRename = async (type) => {
    if (!editName.trim()) {
      setError({ id: type.id, message: t("catalogPage.errors.required") });
      return;
    }
    const ok = await run(type.id, () => catalogApi.updateServiceType(type.id, { name: editName.trim() }));
    if (ok) setEditingId(null);
  };

  return (
    <Modal open={open} onClose={onClose} title={t("catalogPage.typesTitle")} maxWidth="lg">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">{t("catalogPage.typesHint")}</p>

        <form onSubmit={create} className="flex items-start gap-2" noValidate>
          <div className="flex-1">
            <Input
              aria-label={t("catalogPage.newType")}
              placeholder={t("catalogPage.newType")}
              value={newName}
              onChange={(event) => { setNewName(event.target.value); setError({ id: null, message: "" }); }}
              maxLength={100}
              error={error.id === "new" ? error.message : undefined}
            />
          </div>
          <Button type="submit" disabled={busy}>{t("catalogPage.add")}</Button>
        </form>

        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
          {types.map((type) => (
            <li key={type.id} className={`flex items-center gap-2 px-3 py-2 ${type.active ? "" : "opacity-60"}`}>
              <div className="flex-1">
                {editingId === type.id ? (
                  <Input
                    aria-label={t("catalogPage.typeName")}
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    maxLength={100}
                    error={error.id === type.id ? error.message : undefined}
                  />
                ) : (
                  <>
                    <span className="text-sm text-slate-800">{type.name}</span>
                    {error.id === type.id && <p className="text-xs text-red-500">{error.message}</p>}
                  </>
                )}
              </div>
              <Badge status={type.active ? "generated" : "draft"} label={type.active ? t("catalogPage.active") : t("catalogPage.inactive")} />
              {editingId === type.id ? (
                <>
                  <Button size="sm" disabled={busy} onClick={() => saveRename(type)}>{t("catalogPage.save")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setError({ id: null, message: "" }); }}>{t("catalogPage.cancel")}</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="secondary" onClick={() => { setEditingId(type.id); setEditName(type.name); setError({ id: null, message: "" }); }}>{t("catalogPage.rename")}</Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(type.id, () => catalogApi.updateServiceType(type.id, { active: !type.active }))}
                  >
                    {type.active ? t("catalogPage.deactivate") : t("catalogPage.activate")}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>{t("catalogPage.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
