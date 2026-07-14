from sqlalchemy import Column, Integer, String, Text
from app.database import Base

class Proposal(Base):
    __tablename__ = "propuesta"

    id_propuesta = Column(Integer, primary_key=True, index=True)
    id_empresa = Column(Integer)
    id_usuario = Column(Integer)
    titulo = Column(String)
    contenido = Column(Text)
    estado = Column(String)
    id_plantilla = Column(Integer)
    id_idioma = Column(Integer)