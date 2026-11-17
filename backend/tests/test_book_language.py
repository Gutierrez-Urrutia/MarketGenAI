"""Idioma y contenido de capítulos: nombre completo del idioma en los prompts, no recortar por corchetes,
y rechazar (reintentar) capítulos vacíos, con plantillas sin rellenar o en otro idioma."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.languages import detect_language, is_wrong_language, language_name, normalize_language
from app.services import book_ai_service as books
from app.workers.tasks import asset_tasks

ES = ("El marketing con inteligencia artificial permite a los equipos crear contenido para sus audiencias con más rapidez, "
      "pero también exige que se mantenga la revisión humana y que se respete la voz de la marca en cada pieza. ") * 6
EN = ("Marketing with artificial intelligence allows teams to create content for their audiences much faster, "
      "but it also requires that the human review is kept and that the voice of the brand is respected in every piece. ") * 6
PT = ("O marketing com inteligência artificial permite que as equipes criem conteúdo para os seus públicos com mais rapidez, "
      "mas também exige que a revisão humana seja mantida e que a voz da marca seja respeitada em cada peça. ") * 6


def html(text):
    return f"<h2>Capítulo</h2><p>{text}</p>"


class TestLanguageNames:
    def test_codes_become_full_names(self):
        assert language_name("es") == "Spanish (español)"
        assert language_name("en") == "English"
        assert language_name("pt") == "Portuguese (português)"

    def test_regional_codes_and_case_are_normalised(self):
        assert normalize_language("ES-cl") == "es"
        assert normalize_language(" pt_BR ") == "pt"
        assert language_name("ES") == "Spanish (español)"

    def test_missing_defaults_to_english_and_unknown_passes_through(self):
        assert language_name(None) == "English"
        assert language_name("") == "English"
        assert language_name("fr") == "fr"


class TestLanguageDetection:
    def test_detects_each_supported_language(self):
        assert detect_language(ES) == "es"
        assert detect_language(EN) == "en"
        assert detect_language(PT) == "pt"

    def test_short_text_is_not_judged(self):
        assert detect_language("Hola mundo") is None

    def test_wrong_language_is_flagged_only_when_clear(self):
        assert is_wrong_language(EN, "es") is True
        assert is_wrong_language(ES, "es") is False
        assert is_wrong_language("Hola", "es") is False      # muy corto: no se juzga
        assert is_wrong_language(EN, "fr") is False          # idioma no soportado: no se juzga


class TestFenceStripping:
    def test_text_with_square_brackets_is_kept_whole(self):
        """Antes se devolvía solo el tramo entre el primer «[» y el último «]»."""
        original = "<h2>Prompts</h2><p>Usa: Escribe un anuncio para [producto] dirigido a [audiencia] hoy.</p><p>Cierre del capítulo.</p>"
        assert books._strip_code_fences(original) == original

    def test_removes_fences_that_wrap_the_whole_answer(self):
        assert books._strip_code_fences("```html\n<p>hola</p>\n```") == "<p>hola</p>"

    def test_json_cleaner_is_unchanged_for_json(self):
        assert books._clean_fenced_text('Aquí va: ```json\n[{"a": 1}]\n```') == '[{"a": 1}]'


class TestChapterProblem:
    def test_good_chapter_has_no_problem(self):
        assert books.chapter_problem(html(ES), "es") is None

    def test_too_short(self):
        assert "demasiado corto" in books.chapter_problem("<p>[anexo]</p>", "es")

    def test_template_with_unfilled_fields(self):
        template = "<p>" + "[audiencia específica] , que [necesidad] , porque [valor] " * 20 + "</p>"
        assert "plantilla" in books.chapter_problem(template, "es")

    def test_wrong_language(self):
        assert "otro idioma" in books.chapter_problem(html(EN), "es")

    def test_short_content_type_skips_the_length_rule(self):
        assert books.chapter_problem("<p>Texto corto</p>", "es", "short") is None


@pytest.fixture
def llm():
    with patch.object(books.deepseek_service, "generate_text", new=AsyncMock()) as mock:
        yield mock


async def _generate(language="es"):
    return await books.generate_chapter_content("Libro", "Descripción", "Capítulo 1", "Explica el tema", language=language)


class TestGenerateChapterContent:
    async def test_prompt_names_the_language_in_full(self, llm):
        llm.return_value = html(ES)
        await _generate("es")
        prompt = llm.call_args.args[0]
        assert "Spanish (español)" in prompt
        assert "Spanish (español)" in llm.call_args.kwargs["system_prompt"]

    async def test_content_with_brackets_is_not_truncated(self, llm):
        body = html(ES + " Ejemplo: escribe un anuncio para [producto] dirigido a [audiencia]. " + ES)
        llm.return_value = body
        assert await _generate() == body

    async def test_retries_when_the_first_answer_is_only_a_template(self, llm):
        llm.side_effect = ["[anexo]", html(ES)]
        result = await _generate()
        assert result == html(ES)
        assert llm.await_count == 2
        assert "IMPORTANT" in llm.call_args_list[1].args[0]

    async def test_retries_when_the_language_is_wrong(self, llm):
        llm.side_effect = [html(EN), html(ES)]
        assert await _generate("es") == html(ES)
        assert llm.await_count == 2

    async def test_gives_up_with_a_clear_error_after_three_attempts(self, llm):
        llm.return_value = "[anexo]"
        with pytest.raises(books.ChapterContentError, match="Capítulo 1"):
            await _generate()
        assert llm.await_count == 3


class TestWhitepaperFooter:
    def _footer_text(self, language):
        canvas = MagicMock()
        canvas.getPageNumber.return_value = 3
        asset_tasks._page_decoration(language)(canvas, None)
        return canvas.drawRightString.call_args.args[2]

    def test_label_follows_the_document_language(self):
        assert self._footer_text("es") == "Página 3"
        assert self._footer_text("pt") == "Página 3"
        assert self._footer_text("en") == "Page 3"

    def test_default_decoration_is_english_for_compatibility(self):
        canvas = MagicMock()
        canvas.getPageNumber.return_value = 1
        asset_tasks._whitepaper_page_decoration(canvas, None)
        assert canvas.drawRightString.call_args.args[2] == "Page 1"
