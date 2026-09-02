from fastapi import APIRouter

router = APIRouter(
    prefix="/customers",
    tags=["Customers"]
)

mock_customers = [
    {
        "id": 1,
        "name": "Empresa Alpha",
        "email": "alpha@email.com",
        "company": "Alpha Inc"
    },
    {
        "id": 2,
        "name": "Empresa Beta",
        "email": "beta@email.com",
        "company": "Beta LLC"
    }
]

@router.get("")
def list_customers():
    return mock_customers


@router.get("/{customer_id}")
def get_customer(customer_id: int):
    return {
        "id": customer_id,
        "name": "Cliente Demo",
        "email": "demo@email.com",
        "company": "Demo Company"
    }


@router.post("")
def create_customer():
    return {
        "message": "Customer creado correctamente"
    }


@router.put("/{customer_id}")
def update_customer(customer_id: int):
    return {
        "message": f"Customer {customer_id} actualizado"
    }


@router.delete("/{customer_id}")
def delete_customer(customer_id: int):
    return {
        "message": f"Customer {customer_id} eliminado"
    }