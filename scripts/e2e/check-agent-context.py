"""Verify the bundled JSONL context/compaction protocol against an isolated tiny HTTP model."""
import argparse, json, os, pathlib, queue, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Model(BaseHTTPRequestHandler):
    requests = []
    def log_message(self, *args): pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append({'stream': bool(request.get('stream')), 'max_tokens': request.get('max_tokens'), 'messages': len(request.get('messages', [])), 'checkpoint_prompt': any('concise continuation checkpoint' in str(m.get('content', '')) for m in request.get('messages', []))})
        if request.get('stream'):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            for chunk in [{'choices':[{'delta':{'content':'A concise summary of the work so far.'},'index':0}]}, {'choices':[{'delta':{},'index':0,'finish_reason':'stop'}], 'usage':{'prompt_tokens':2500,'completion_tokens':10,'total_tokens':2510}}]:
                self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
        else:
            response=json.dumps({'choices':[{'message':{'role':'assistant','content':'A concise summary of the work so far.'},'finish_reason':'stop'}], 'usage':{'prompt_tokens':2500,'completion_tokens':10,'total_tokens':2510}}).encode()
            self.send_response(200); self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(response))); self.end_headers();self.wfile.write(response)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--work',required=True);args=parser.parse_args()
    root=pathlib.Path(tempfile.mkdtemp(prefix='agent-context-',dir=args.work)).resolve(); events=[]
    (root/'.aionrs.toml').write_text('[compact]\nenabled = true\ncontext_window = 4096\noutput_reserve = 512\nautocompact_buffer = 308\nautocompact_threshold_pct = 80\nemergency_buffer = 204\n')
    server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
    env=os.environ.copy();env.update(NO_PROXY='127.0.0.1,localhost',no_proxy='127.0.0.1,localhost');env.update(APPDATA=str(root/'roaming'),LOCALAPPDATA=str(root/'local'),USERPROFILE=str(root/'home'),HOME=str(root/'home'))
    exe=pathlib.Path(__file__).resolve().parents[2]/'vendor'/'aionrs.exe'
    proc=subprocess.Popen([str(exe),'--json-stream','--provider','openai','--api-key','test','--model','test','--base-url',f'http://127.0.0.1:{server.server_port}/v1','--project-dir',str(root),'--max-tokens','512','--no-color'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,cwd=root)
    q=queue.Queue()
    def read():
        for line in proc.stdout:
            event=json.loads(line);events.append(event);q.put(event)
    threading.Thread(target=read,daemon=True).start()
    def wait_for(predicate):
        deadline=time.time()+25
        while time.time()<deadline:
            try:event=q.get(timeout=.2)
            except queue.Empty:continue
            if event.get('type')=='error':raise AssertionError(event)
            if predicate(event):return event
        raise AssertionError('Timed out waiting for agent event')
    def send(msg_id,content):
        proc.stdin.write(json.dumps({'type':'message','msg_id':msg_id,'content':content})+'\n');proc.stdin.flush()
        return wait_for(lambda e:e.get('type')=='stream_end' and e.get('msg_id')==msg_id)
    try:
        ready=wait_for(lambda e:e.get('type')=='ready');assert ready['version']=='0.2.11',ready
        send('context-before','/context')
        assert any('4.1k tokens' in e.get('message','') for e in events), events
        send('compact-empty','/compact')
        for index in range(5):send(f'turn-{index}',('Development evidence with a distinct historical event and associated analysis. '*160)+str(index))
        send('compact-manual','/compact');send('context-after','/context')
        automatic=[e for e in events if e.get('message','').startswith('Autocompact: summarized')]
        assert automatic, 'No automatic compaction event observed'
        assert any(e.get('message','').startswith('Context compacted:') for e in events), 'Manual compact did not succeed'
        assert any(r['max_tokens']==3072 and r['checkpoint_prompt'] for r in Model.requests), 'Patched checkpoint prompt/cap was not observed'
        assert any(r['max_tokens']==512 for r in Model.requests), 'Ordinary model request did not honor --max-tokens'
        print(json.dumps({'status':'PASS','version':ready['version'],'automatic_compactions':len(automatic),'summary_output_reserve':3072,'ordinary_output_reserve':512,'artifact':str(root)},indent=2))
    finally:
        proc.terminate();proc.wait(timeout=5);server.shutdown()
        (root/'events.json').write_text(json.dumps(events,indent=2));(root/'requests.json').write_text(json.dumps(Model.requests,indent=2));(root/'stderr.txt').write_text(proc.stderr.read())
if __name__=='__main__':main()
