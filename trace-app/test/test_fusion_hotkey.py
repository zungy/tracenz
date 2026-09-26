import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('trace_hotkey_transport', Path(__file__).resolve().parents[1] / 'fusion/DesignRecorderAgent/trace_transport.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ShortcutTest(unittest.TestCase):
    def fixture(self, directory, **overrides):
        request = {
            'version': 1, 'command': 'record-checkpoint', 'id': str(uuid.uuid4()),
            'instanceId': 'current', 'requestedAt': 100000, 'expiresAt': 105000,
        }
        request.update(overrides)
        module.atomic_json(Path(directory) / 'connection.json', {'instanceId': 'current'})
        module.atomic_json(Path(directory) / 'checkpoint-request.json', request)
        return request

    def test_dispatch_once_and_write_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            listener = module.CheckpointShortcuts(calls.append, directory, lambda: True, lambda: 100)
            request = self.fixture(directory)
            listener.tick()
            listener.tick()
            self.assertEqual(calls, [request])
            status = json.loads((Path(directory) / 'fusion-shortcut-status.json').read_text())
            self.assertTrue(status['foreground'])
            self.assertEqual(status['addinVersion'], '0.6.0')
            listener.stop()
            self.assertFalse(json.loads((Path(directory) / 'fusion-shortcut-status.json').read_text())['foreground'])

    def test_stale_future_wrong_instance_and_background_requests_do_not_capture(self):
        cases = [
            ({'requestedAt': 90000, 'expiresAt': 95000}, True),
            ({'requestedAt': 99999}, True),  # Predates add-in startup.
            ({'requestedAt': 102000, 'expiresAt': 105000}, True),
            ({'expiresAt': 110000}, True),
            ({'instanceId': 'stale'}, True),
            ({'command': 'execute-code'}, True),
            ({}, False),
        ]
        for values, foreground in cases:
            with self.subTest(values=values, foreground=foreground), tempfile.TemporaryDirectory() as directory:
                calls = []
                listener = module.CheckpointShortcuts(calls.append, directory, lambda: foreground, lambda: 100)
                self.fixture(directory, **values)
                listener.tick()
                self.assertEqual(calls, [])

    def test_ui_dispatch_rechecks_expiry_focus_and_modeling_command(self):
        with tempfile.TemporaryDirectory() as directory:
            foreground, now = [True], [100]
            listener = module.CheckpointShortcuts(lambda _: None, directory, lambda: foreground[0], lambda: now[0])
            request = self.fixture(directory)
            self.assertTrue(listener.can_dispatch(request, 'SelectCommand'))
            self.assertFalse(listener.can_dispatch(request, 'Extrude'))
            self.assertFalse(listener.can_dispatch(request, 'SelectCommand', busy=True))
            foreground[0] = False
            self.assertFalse(listener.can_dispatch(request, 'SelectCommand'))
            foreground[0], now[0] = True, 106
            self.assertFalse(listener.can_dispatch(request, 'SelectCommand'))


if __name__ == '__main__':
    unittest.main()
