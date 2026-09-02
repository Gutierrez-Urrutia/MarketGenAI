"""
Contexto RAG de propuestas históricas de Netprovider.
Usado para enriquecer el prompt de generación de propuestas en DeepSeek.
"""

HISTORICAL_PROPOSALS = [
    {
        "title": "Monitoreo de Seguridad - Aseguradora Magallanes",
        "summary": "Propuesta de servicio de monitoreo de seguridad perimetral 7x24 para Aseguradora Magallanes. Incluye monitoreo de firewall, IPS y gestión de incidentes de seguridad. Servicio basado en economías de escala con NOC en Chile y USA.",
    },
    {
        "title": "Monitoreo de Disponibilidad Interno - Aseguradora Magallanes",
        "summary": "Propuesta de monitoreo de disponibilidad de servidores y servicios internos para Aseguradora Magallanes. Continuidad operativa 7x24, alertas en tiempo real, informes mensuales. Netprovider posicionado como empresa de monitoreo más grande de Chile.",
    },
    {
        "title": "Application Firewall - Aseguradora Magallanes",
        "summary": "Propuesta de servicio de Application Firewall para protección de aplicaciones web de Aseguradora Magallanes. Incluye análisis de tráfico HTTP/HTTPS, protección contra ataques OWASP Top 10 y reportes de seguridad.",
    },
    {
        "title": "Monitoreo de Disponibilidad Interno - Magallanes (2012)",
        "summary": "Propuesta comercial de monitoreo de disponibilidad interno para Magallanes. Servicios de seguridad y monitoreo 24x7, NOC en Chile y USA, presencia en Perú, Colombia y Estados Unidos. Modelo de economías de escala.",
    },
    {
        "title": "Prueba de Rendimiento de Aplicaciones SOAP",
        "summary": "Propuesta de servicio de prueba de rendimiento para aplicaciones SOAP. Análisis de carga, stress testing y medición de tiempos de respuesta bajo distintos escenarios de concurrencia.",
    },
    {
        "title": "Monitoreo de Seguridad - Magallanes IPS Segundo Enlace",
        "summary": "Propuesta de ampliación del servicio de monitoreo de seguridad para Magallanes, incorporando un segundo enlace IPS. Redundancia de conectividad y continuidad del monitoreo de seguridad perimetral.",
    },
    {
        "title": "Servicio Integral de Seguridad - ABCDIN",
        "summary": "Propuesta de servicio integral de seguridad para ABCDIN. Incluye monitoreo de seguridad perimetral, gestión de firewall, análisis de vulnerabilidades y respuesta a incidentes para retail con múltiples sucursales.",
    },
    {
        "title": "Servicios de Help Desk",
        "summary": "Propuesta de servicios de Help Desk para soporte a usuarios. Mesa de ayuda nivel 1 y 2, gestión de tickets, SLAs definidos, reportes de gestión mensuales y cobertura horaria extendida.",
    },
    {
        "title": "Estudio de Calidad de Sitios - Líneas Aéreas Americanas",
        "summary": "Propuesta de estudio de calidad y disponibilidad de sitios web para aerolíneas americanas. Medición de uptime, tiempos de carga, disponibilidad desde distintos puntos geográficos y benchmarking competitivo.",
    },
    {
        "title": "Revisión de Seguridad Perimetral Externa",
        "summary": "Propuesta de revisión de seguridad perimetral externa (ethical hacking). Análisis de vulnerabilidades externas, pruebas de penetración controladas, informe ejecutivo y técnico con plan de remediación.",
    },
    {
        "title": "Revisión Perimetral Externa e Interna - AIEP",
        "summary": "Propuesta de revisión de seguridad perimetral externa e interna para AIEP. Análisis completo de la superficie de ataque, pruebas de penetración internas y externas, y recomendaciones de hardening.",
    },
    {
        "title": "Monitoreo de Disponibilidad y Seguridad Perimetral con Respaldos",
        "summary": "Propuesta combinada de monitoreo de disponibilidad, administración de seguridad perimetral y respaldos de servidores. Servicio integral de operaciones IT con SLAs definidos y reportes ejecutivos mensuales.",
    },
    {
        "title": "Servicio de Antivirus y Antispam",
        "summary": "Propuesta de servicio administrado de antivirus y antispam. Protección de endpoints y correo electrónico, actualizaciones automáticas de firmas, consola centralizada de administración y reportes de amenazas.",
    },
    {
        "title": "Monitoreo de Disponibilidad Interno (versión estándar)",
        "summary": "Propuesta estándar de monitoreo de disponibilidad interno. Supervisión de servidores y servicios críticos, alertas automáticas, dashboard en tiempo real e informes de disponibilidad mensual.",
    },
    {
        "title": "Monitoreo de Disponibilidad Interno (versión extendida)",
        "summary": "Versión extendida de la propuesta de monitoreo de disponibilidad interno. Mayor cobertura de servicios monitoreados, mayor frecuencia de polling y SLAs más exigentes de tiempo de respuesta.",
    },
    {
        "title": "Monitoreo de Plataforma",
        "summary": "Propuesta de servicios de monitoreo de plataforma tecnológica completa. Cobertura de infraestructura de red, servidores, aplicaciones y servicios, con escalamiento de alertas y gestión de incidentes.",
    },
]

# Estructura común observada en las propuestas históricas de Netprovider
PROPOSAL_STRUCTURE_GUIDE = """
Las propuestas históricas de Netprovider siguen esta estructura:
1. Acuerdo de Confidencialidad
2. Resumen Ejecutivo — problema del cliente y propuesta de valor
3. Descripción de la Empresa (Netprovider/NoonDalton) — historia, capacidades, diferenciadores
4. Alcance y Objetivos — qué se entrega exactamente
5. Descripción Técnica del Servicio — cómo funciona
6. Organización del Trabajo / Equipo — roles y responsabilidades
7. Precios y Condiciones Comerciales — tabla de precios, forma de pago
8. Condiciones Generales — SLAs, garantías, exclusiones

Tono: profesional, técnico pero accesible, orientado a la continuidad operativa y el ROI del cliente.
Diferenciador de NoonDalton: economías de escala, experiencia comprobada, operación 7x24, cobertura regional en Latinoamérica.
"""


def get_rag_context(client_name: str = "", service_type: str = "") -> str:
    """
    Retorna contexto RAG relevante para enriquecer el prompt de generación de propuestas.
    Selecciona las propuestas más relevantes según el tipo de servicio.
    """
    # Seleccionar propuestas relevantes (máx 3 para no exceder tokens)
    relevant = HISTORICAL_PROPOSALS[:3]

    examples = "\n".join([
        f"- {p['title']}: {p['summary']}"
        for p in relevant
    ])

    return f"""
CONTEXTO DE PROPUESTAS HISTÓRICAS DE REFERENCIA:
Las siguientes propuestas reales de NoonDalton/Netprovider sirven como referencia de estilo, estructura y tono:

{examples}

GUÍA DE ESTRUCTURA:
{PROPOSAL_STRUCTURE_GUIDE}

Usa este contexto para que la propuesta generada sea coherente con el estilo y estándares de NoonDalton.
"""
