from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

from app.routers import proposals, books, customers, templates, settings

app = FastAPI(title="MarketGen AI API", version="1.0.0")

origins = os.getenv("CORS_ORIGINS", "").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api")
def home():
    return {"message": "Backend MarketGen AI funcionando"}

# Routers reales
app.include_router(proposals.router, prefix="/api/v1")
app.include_router(books.router, prefix="/api/v1")
app.include_router(customers.router, prefix="/api/v1")
app.include_router(templates.router, prefix="/api/v1")
app.include_router(settings.router, prefix="/api/v1")
