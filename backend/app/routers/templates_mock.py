from fastapi import APIRouter

router = APIRouter(
    prefix="/templates",
    tags=["Templates"],
)


@router.get("")
def list_templates():
    return [
        {
            "id": 1,
            "name": "Proposal Template",
            "type": "proposal",
            "status": "active",
        }
    ]


@router.post("")
def create_template():
    return {"message": "Template creado correctamente"}


@router.get("/{template_id}")
def get_template(template_id: int):
    return {
        "id": template_id,
        "name": "Template Demo",
        "type": "proposal",
        "status": "active",
    }


@router.put("/{template_id}")
def update_template(template_id: int):
    return {"message": f"Template {template_id} actualizado"}


@router.delete("/{template_id}")
def delete_template(template_id: int):
    return {"message": f"Template {template_id} eliminado"}