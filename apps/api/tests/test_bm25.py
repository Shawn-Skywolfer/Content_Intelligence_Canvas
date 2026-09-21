from app.services.retrieval.bm25 import bm25_scores
from app.services.retrieval.tokenizer import tokenize


def test_chinese_and_english_tokenization() -> None:
    tokens = tokenize("Alpha Data Hub 的运行问题与800unit")
    assert "alpha" in tokens
    assert "data" in tokens
    assert "hub" in tokens
    assert "800unit" in tokens


def test_bm25_prefers_matching_document() -> None:
    scores = bm25_scores("alpha system", ["alpha system reference", "liquid cooling reference"])
    assert scores[0] > scores[1]
