"""覆盖旧快照、生成任务和页面切换交错时的图保存行为。"""
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from app.repositories.workspace import WorkspaceRepository


class CanvasEdgePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "app.db"
        self.repo = WorkspaceRepository(self.path)
        self.project_id = self.repo.create_project("回归测试", "输入")['id']
        self.before = self.repo.get_canvas(self.project_id)
        self.a, self.b = self.before['nodes'][:2]

    def tearDown(self):
        self.directory.cleanup()

    def save(self, board):
        return self.repo.replace_canvas(self.project_id, board['nodes'], board['edges'], board['viewport'], board['updated_at'])

    def test_new_edge_between_existing_nodes_survives_old_snapshot(self):
        edge = self.repo.create_edge(self.project_id, self.a['id'], self.b['id'], metadata={'source_handle': 'bottom', 'target_handle': 'top'})
        saved = self.save(self.before)
        actual = next(e for e in saved['edges'] if e['id'] == edge['id'])
        self.assertEqual(actual['metadata'], edge['metadata'])
        self.assertEqual(WorkspaceRepository(self.path).get_canvas(self.project_id)['edges'], saved['edges'])

    def test_second_ai_source_survives_snapshot_that_already_contains_new_node(self):
        generated = self.repo.create_node(self.project_id, {'created_by':'ai', 'parent_id':self.a['id'], 'metadata':{'source_node_ids':[self.a['id'],self.b['id']]}})
        intermediate = self.repo.get_canvas(self.project_id)
        edge = self.repo.create_edge(self.project_id, self.b['id'], generated['id'], 'transforms')
        saved = self.save(intermediate)
        self.assertTrue(any(e['id'] == edge['id'] for e in saved['edges']))
        self.assertEqual({n['id'] for n in self.repo.upstream_nodes(self.project_id,[generated['id']],1)}, {self.a['id'],self.b['id']})

    def test_intentional_edge_deletion_is_not_undone_on_reload(self):
        edge = self.repo.create_edge(self.project_id,self.a['id'],self.b['id'])
        board = self.repo.get_canvas(self.project_id)
        board['edges'] = [e for e in board['edges'] if e['id'] != edge['id']]
        saved = self.save(board)
        self.assertNotIn(edge['id'], {e['id'] for e in saved['edges']})
        for _ in range(3):
            self.assertNotIn(edge['id'], {e['id'] for e in WorkspaceRepository(self.path).get_canvas(self.project_id)['edges']})

    def test_failed_replacement_rolls_back_nodes_and_edges(self):
        edge = self.repo.create_edge(self.project_id,self.a['id'],self.b['id'])
        board = self.repo.get_canvas(self.project_id)
        edited = {**board, 'nodes':[{**n,'x':n['x']+123} for n in board['nodes']]}
        original = self.repo.create_edge
        def fail(*args, **kwargs): raise RuntimeError('模拟写入失败')
        self.repo.create_edge = fail
        try:
            with self.assertRaises(RuntimeError): self.save(edited)
        finally: self.repo.create_edge = original
        self.assertEqual(self.repo.get_canvas(self.project_id), board)

    def test_other_connection_never_sees_temporarily_deleted_edges(self):
        edge = self.repo.create_edge(self.project_id,self.a['id'],self.b['id'])
        board = self.repo.get_canvas(self.project_id)
        board['edges'] = [{**edge, 'id':'replacement'}]
        entered, release = threading.Event(), threading.Event()
        original = self.repo.create_edge
        def delayed(*args, **kwargs):
            entered.set()
            if not release.wait(5): raise TimeoutError('验收超时')
            return original(*args, **kwargs)
        self.repo.create_edge = delayed
        with ThreadPoolExecutor() as executor:
            pending = executor.submit(self.save, board)
            try:
                self.assertTrue(entered.wait(5))
                with sqlite3.connect(self.path) as db:
                    ids = {r[0] for r in db.execute('SELECT id FROM canvas_edges WHERE project_id=?',(self.project_id,))}
                self.assertIn(edge['id'],ids)
            finally: release.set()
            saved = pending.result(timeout=5)
        self.assertIn('replacement',{e['id'] for e in saved['edges']})

    def test_upgrade_recovers_recorded_ai_sources_only_once(self):
        node = self.repo.create_node(self.project_id, {'created_by':'ai','metadata':{'source_node_ids':[self.a['id'],self.b['id'],'missing']}})
        with self.repo._connect() as db:
            db.execute('DELETE FROM app_settings WHERE key=?',(f'generated_edges_recovered_v31:{self.project_id}',))
        board = WorkspaceRepository(self.path).get_canvas(self.project_id)
        edges = [e for e in board['edges'] if e['target_node_id'] == node['id']]
        self.assertEqual({e['source_node_id'] for e in edges},{self.a['id'],self.b['id']})
        board['edges'] = [e for e in board['edges'] if e['target_node_id'] != node['id']]
        self.save(board)
        self.assertFalse(any(e['target_node_id'] == node['id'] for e in self.repo.get_canvas(self.project_id)['edges']))

    def test_stale_save_keeps_server_prompt_history_and_source_ids(self):
        node = self.repo.create_node(self.project_id, {'metadata':{}})
        board = self.repo.get_canvas(self.project_id)
        values = {'ai_prompt_history':[{'instruction':'我的要求'}], 'source_node_ids':[self.a['id']]}
        self.repo.update_node(self.project_id,node['id'],{'metadata':values})
        self.save(board)
        self.assertEqual(self.repo.get_node(node['id'])['metadata'],values)


if __name__ == '__main__': unittest.main()
