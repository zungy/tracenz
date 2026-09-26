"""Exercise the shipped Python uploader against an actual Trace receiver."""
import importlib.util
import json
from pathlib import Path
import sys
spec=importlib.util.spec_from_file_location('transport',Path(__file__).resolve().parents[1]/'fusion/DesignRecorderAgent/trace_transport.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
directory=Path(sys.argv[1])
transport=module.Transport(directory)
if sys.argv[2]=='queue':
    event=json.loads((directory/'event.json').read_text(encoding='utf-8'))
    result=transport.enqueue(event,directory/'viewport.png',directory/'event.json')
    assert result['queued']
    transport.tick()
    assert len(list(transport.outbox.glob('*.json')))==1
else:
    transport.tick()
    assert not list(transport.outbox.glob('*.json'))
    assert json.loads((directory/'event.json').read_text(encoding='utf-8'))['remoteUpload']['ok']
