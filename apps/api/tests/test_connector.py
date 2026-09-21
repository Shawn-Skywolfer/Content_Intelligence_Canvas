import asyncio
from pathlib import Path

from app.adapters.knowledge.local_vault import LocalVaultConnector


def test_connector_scans_real_files_not_index_inventory(tmp_path: Path) -> None:
    (tmp_path / "index.md").write_text("# Index\nOnly one listed", encoding="utf-8")
    (tmp_path / "real.md").write_text("# Real", encoding="utf-8")
    connector = LocalVaultConnector(tmp_path)
    refs = asyncio.run(connector.list_documents())
    assert [ref.relative_path for ref in refs] == ["index.md", "real.md"]


def test_connector_rejects_escape(tmp_path: Path) -> None:
    connector = LocalVaultConnector(tmp_path)
    outside = tmp_path.parent / "outside.md"
    outside.write_text("# Outside", encoding="utf-8")
    from app.domain.knowledge import KnowledgeDocumentRef

    ref = KnowledgeDocumentRef("../outside.md", outside, 1, 1)
    try:
        asyncio.run(connector.read_document(ref))
    except ValueError as exc:
        assert "escapes" in str(exc)
    else:
        raise AssertionError("Expected path escape to be rejected")

