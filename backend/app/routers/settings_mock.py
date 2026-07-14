from fastapi import APIRouter

router = APIRouter(
    prefix="/settings",
    tags=["Settings"]
)

mock_settings = {
    "crm": {
        "provider": "HubSpot",
        "endpoint": "https://api.hubapi.com",
        "connected": False
    },
    "llm": {
        "provider": "DeepSeek",
        "model": "deepseek-chat"
    }
}


@router.get("")
async def get_settings():
    return mock_settings


@router.put("/crm")
async def update_crm_settings(payload: dict):

    mock_settings["crm"].update(payload)

    return {
        "message": "CRM settings updated",
        "crm": mock_settings["crm"]
    }


@router.post("/crm/test-connection")
async def test_crm_connection():
    return {
        "connected": True,
        "message": "CRM connection successful"
    }


@router.put("/llm")
async def update_llm_settings(payload: dict):

    mock_settings["llm"].update(payload)

    return {
        "message": "LLM settings updated",
        "llm": mock_settings["llm"]
    }
