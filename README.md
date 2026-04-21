# AgentGround

## 启动命令

### 后端（FastAPI）

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

服务默认：<http://localhost:8000>。配置说明见 [server/README.md](server/README.md)。

### 前端（Vite + React）

```bash
cd front
npm install
npm run dev
```

开发服务器默认：<http://localhost:3000>（`vite --port=3000 --host=0.0.0.0`）。更多说明见 [front/README.md](front/README.md)。
