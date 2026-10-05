"""Boundary checks without loading a model or importing MLX."""
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
import server


class Boundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close()

    def request(self, path, origin='https://tungwinxp.github.io', host='127.0.0.1:18773', method='GET', token=True):
        connection = http.client.HTTPConnection(*self.http.server_address)
        headers = {'Host': host, 'Origin': origin, 'Content-Type': 'application/json'}
        if token: headers['X-JMFS-Guide'] = '1'
        connection.request(method, path, '{}' if method == 'POST' else None, headers)
        response = connection.getresponse(); body = response.read(); status = response.status
        connection.close(); return status, json.loads(body) if body else None

    def test_origin_host_and_header(self):
        status, health = self.request('/health')
        self.assertEqual(status, 200); self.assertFalse(health['loaded'])
        self.assertEqual(self.request('/health', origin='https://unrelated.invalid')[0], 403)
        self.assertEqual(self.request('/health', host='unrelated.invalid:18773')[0], 403)
        self.assertEqual(self.request('/release', method='POST', token=False)[0], 403)
        self.assertEqual(self.request('/arbitrary-model', method='POST')[0], 404)
        self.assertEqual(self.request('/release', method='POST')[0], 200)

    def test_only_one_active_request(self):
        server.work.acquire(); server.active_id = 'another-request'
        try:
            self.assertEqual(self.request('/load', method='POST')[0], 409)
            self.assertEqual(self.request('/release', method='POST')[0], 409)
        finally:
            server.active_id = None; server.work.release()

    def test_minicpm_xml_uses_only_declared_tools_and_parameters(self):
        tools = [{'function': {'name': 'search_motif', 'parameters': {'properties': {
            'name': {'type': 'string'}, 'database_ids': {'type': 'array'}}}}}]
        text = '<function name="search_motif"><param name="name">chymotrypsin</param><param name="database_ids">["1"]</param></function> extra output'
        result = server.tool_call(text, tools)
        self.assertEqual(json.loads(result['arguments']), {'name': 'chymotrypsin', 'database_ids': ['1']})
        self.assertIsNone(server.tool_call('<function name="search_motif">', tools))
        with self.assertRaises(ValueError): server.tool_call(text.replace('search_motif', 'unknown'), tools)
        padded = server.tool_call(text.replace('database_ids', 'arbitrary_path'), tools)
        self.assertEqual(json.loads(padded['arguments']), {'name': 'chymotrypsin'})
        with self.assertRaises(ValueError): server.tool_call(text.replace('database_ids', 'name'), tools)

    def test_small_model_values_are_normalised_or_left_for_schema_validation(self):
        tools = [{'function': {'name': 'protein_view', 'parameters': {'properties': {
            'action': {'type': 'string'}, 'target': {'type': 'boolean'}, 'chains': {'type': 'array'}, 'factor': {'type': 'number'}}}}}]
        call = lambda body: json.loads(server.tool_call('<function name="protein_view">' + body + '</function>', tools)['arguments'])
        self.assertEqual(call('<param name="action">query</param><param name="target">hide</param><param name="chains"></param>'),
                         {'action': 'query', 'target': False})
        self.assertEqual(call('<param name="action">zoom</param><param name="factor">2.0</param><param name="target">all</param>'),
                         {'action': 'zoom', 'factor': 2.0, 'target': 'all'})


if __name__ == '__main__': unittest.main()
