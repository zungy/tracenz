import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec=importlib.util.spec_from_file_location('transport',Path(__file__).resolve().parents[1]/'fusion/DesignRecorderAgent/trace_transport.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class DeliveryTest(unittest.TestCase):
    def test_offline_restart_reconnect_and_ack(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp); image=directory/'image.png'; image.write_bytes(b'fixture')
            event={'id':'fixed-id','rationale':'original'};eventpath=directory/'event.json';module.atomic_json(eventpath,event)
            first=module.Transport(directory);first.enqueue(event,image,eventpath);first.tick()
            self.assertEqual(len(list(first.outbox.glob('*.json'))),1)
            received=[]
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200);self.end_headers();self.wfile.write(b'{"service":"trace-backend","instanceId":"test"}')
                def do_POST(self):
                    received.append((self.headers.get('Authorization'),json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                    self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true,"eventId":"saved","status":"pending"}')
                def log_message(self,*args): pass
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                module.atomic_json(directory/'connection.json',{'version':1,'url':'http://127.0.0.1:'+str(server.server_port),'instanceId':'test','uploadToken':'trc_'+'a'*64})
                restarted=module.Transport(directory);restarted.tick()
                self.assertEqual(len(received),1);self.assertEqual(received[0][1]['event']['id'],'fixed-id')
                self.assertEqual(len(list(restarted.outbox.glob('*.json'))),0)
                self.assertTrue(json.loads(eventpath.read_text())['remoteUpload']['ok'])
                record=json.loads((directory/'connection.json').read_text());record['url']='http://example.com';module.atomic_json(directory/'connection.json',record)
                with self.assertRaises(ValueError):restarted.connection()
            finally:server.shutdown();server.server_close();thread.join()

    def test_failure_retention_backoff_and_stale_identity(self):
        # A failed acknowledgment must never discard the original or outbox.
        for code,body,blocked,instance in [(503,b'{}',False,'test'),(400,b'{}',True,'test'),(200,b'{"ok":false}',False,'test'),(200,b'{}',False,'stale')]:
            with self.subTest(code=code,body=body,instance=instance), tempfile.TemporaryDirectory() as temp:
                directory=Path(temp); image=directory/'image.png';image.write_bytes(b'fixture')
                eventpath=directory/'event.json';module.atomic_json(eventpath,{'id':'same','rationale':'preserved'})
                uploads=[]
                class Handler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        self.send_response(200);self.end_headers();self.wfile.write(b'{"service":"trace-backend","instanceId":"test"}')
                    def do_POST(self):
                        uploads.append(True);self.rfile.read(int(self.headers['Content-Length']))
                        self.send_response(code);self.end_headers();self.wfile.write(body)
                    def log_message(self,*args):pass
                server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                try:
                    module.atomic_json(directory/'connection.json',{'version':1,'url':'http://127.0.0.1:'+str(server.server_port),'instanceId':instance,'uploadToken':'trc_'+'b'*64})
                    transport=module.Transport(directory);transport.enqueue({'id':'same'},image,eventpath);transport.tick()
                    pending=list(transport.outbox.glob('*.json'));self.assertEqual(len(pending),1)
                    record=json.loads(pending[0].read_text());self.assertEqual(record['blocked'],blocked)
                    self.assertEqual(json.loads(eventpath.read_text())['rationale'],'preserved')
                    transport.tick();self.assertEqual(len(uploads),0 if instance=='stale' else 1)
                finally:server.shutdown();server.server_close();thread.join()

    def test_capture_and_normalization_unchanged(self):
        import ast
        root=Path(__file__).resolve().parents[1]
        original=root/'DesignRecorderAgent/DesignRecorderAgent.py'
        if not original.exists(): self.skipTest('Original user reference is excluded from distribution')
        before={node.name:ast.dump(node) for node in ast.parse(original.read_text(encoding='utf-8')).body if isinstance(node,ast.FunctionDef)}
        after={node.name:ast.dump(node) for node in ast.parse((root/'fusion/DesignRecorderAgent/DesignRecorderAgent.py').read_text(encoding='utf-8')).body if isinstance(node,ast.FunctionDef)}
        expected={'_timestamp_for_file','_upload_event','_record_checkpoint','run','stop'}
        self.assertEqual(set(before),set(after))
        self.assertEqual({name for name in before if before[name]!=after[name]},expected)

if __name__=='__main__':unittest.main()
