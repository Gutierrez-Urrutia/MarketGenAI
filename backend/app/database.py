from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from urllib.parse import quote_plus

DB_PASSWORD = quote_plus("1234")

DATABASE_URL = f"postgresql://postgres:{DB_PASSWORD}@localhost:5432/marketgenai"

engine = create_engine(DATABASE_URL)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()