# 优化执行手册:bge-m3 向量升级 + MinerU GPU 化

> 2026-08-31 定稿。给新会话的执行文档:两项任务相互独立,按序执行即可。
> 环境:D:\DeepTutor(frontend 3782 / backend 8001)、Ollama(11434)、D:\MinerU(uv venv py3.12,MinerU 3.4.5)。
> GPU:RTX 5060 8GB,驱动 610.74(满足 cu128)。
> 注意:涉及 Windows 路径写 JSON 一律用**正斜杠**(`\v` 会被转义成垂直制表符,已踩坑)。

---

## 任务 1:embedding 换 bge-m3(预计 1.5h,几乎全是后台等待)

现状:embedding = Ollama `nomic-embed-text`(768 维,英文中心)。语料是中英混合,检索打折。
目标:换 `bge-m3`(1024 维,多语/中文强/8K 上下文),重建两个 KB。

### 1.1 拉模型
```bash
ollama pull bge-m3
ollama list                      # 确认 bge-m3 在列
curl -s http://localhost:11434/v1/embeddings -H "Content-Type: application/json" \
  -d '{"input":"测试","model":"bge-m3"}' | head -c 120    # 应返回向量
```

### 1.2 切换 DeepTutor 配置(二选一)
**UI 路线(推荐)**:设置 → 模型目录 → embedding profile「Ollama local」→ 添加模型 bge-m3、维度 1024 → 设为 active → 保存应用。
**JSON 路线**:`D:\DeepTutor\data\user\settings\model_catalog.json` 的 `services.embedding`:
- 保留原 `emb-model-nomic` 条目(回滚用),新增:
  ```json
  {"id":"emb-model-bge3","name":"bge-m3","model":"bge-m3","dimension":"1024","supported_dimensions":"1024"}
  ```
- `active_model_id` → `"emb-model-bge3"`(profile 的 base_url `http://localhost:11434/v1/embeddings`、api_key `ollama-local` 不动)
- 重启:关掉现有 deeptutor 进程后运行 `D:\DeepTutor\start.bat`

### 1.3 重建 KB(必须!维度变了旧向量作废)
```bash
cd /d/DeepTutor
# rl-notes:只能喂 md(ipynb 会让 Ollama 崩,历史事故)
MDL=$(find "/d/Reinforcement-Learning-Study-Note/Reinforcement-Learning-Study-Note" -name "*.md" -not -path "*.venv*" -not -path "*pytest_cache*" | sed 's/^/ --doc "/' | sed 's/$/"/' | tr '\n' ' ')
echo y | ./venv/Scripts/deeptutor.exe kb delete rl-notes
eval "./venv/Scripts/deeptutor.exe kb create rl-notes $MDL"
./venv/Scripts/deeptutor.exe kb add-web-source rl-notes -u "https://huggingface.co/learn/deep-rl-course/unit1/introduction" --max-depth 2 --max-pages 60

# prob-stats:2 PDF + 2 转换好的 md(md 已在 books/prob-stats/ 下,勿删)
echo y | ./venv/Scripts/deeptutor.exe kb delete prob-stats
./venv/Scripts/deeptutor.exe kb create prob-stats --doc "D:/DeepTutor/books/prob-stats/DeGroot-Schervish_Probability-and-Statistics_4e.pdf"
./venv/Scripts/deeptutor.exe kb add prob-stats --doc "D:/DeepTutor/books/prob-stats/Hogg-Craig_Intro-Mathematical-Statistics_5e.pdf"
./venv/Scripts/deeptutor.exe kb add prob-stats --doc "D:/DeepTutor/books/prob-stats/Panaretos_Statistics-for-Mathematicians_2016.md"
./venv/Scripts/deeptutor.exe kb add prob-stats --doc "D:/DeepTutor/books/prob-stats/Linde_Probability-Theory_2016.md"
./venv/Scripts/deeptutor.exe kb set-default rl-notes
```
长任务放后台跑,轮询 `kb list` 到 ready(DeGroot 911 页约 4 分钟,其余快)。

### 1.4 验收
```bash
./venv/Scripts/deeptutor.exe kb search rl-notes "策略迭代和价值迭代的区别"     # 应命中中文笔记
./venv/Scripts/deeptutor.exe kb search prob-stats "central limit theorem 条件" # 应命中英文教材
```
中文问英文书能召回 = 升级生效。

### 回滚
model_catalog.json 把 `active_model_id` 改回 `emb-model-nomic` + 重建 KB(命令同 1.3)。

---

## 任务 2:MinerU 上 GPU(预计 30-60 min,主要是下载)

现状:D:\MinerU\venv 里是 CPU torch(单页约 50s,全本不可用)。5060 是 Blackwell 架构(sm_120),**必须 torch≥2.8 + cu128**,普通 pip 源的 torch 不支持。

### 2.1 升级 torch 到 CUDA 版
```bash
export UV_PYTHON_INSTALL_DIR="D:\\MinerU\\pythons" UV_CACHE_DIR="D:\\MinerU\\uv-cache"
uv pip install --python "D:\\MinerU\\venv\\Scripts\\python.exe" \
  --index-url https://download.pytorch.org/whl/cu128 \
  --upgrade "torch>=2.8" torchvision
```
下载约 3GB,放后台跑。装完验证:
```bash
/d/MinerU/venv/Scripts/python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# 期望:2.8.x+cu128 True NVIDIA GeForce RTX 5060
```
若 `torch.cuda.is_available()` 为 False:先查 `nvidia-smi` 驱动(610.74 已达标),再确认 torch 版本字符串含 `+cu128`(CPU 版显示不了 cu)。

### 2.2 冒烟测试(模型已在 D:\MinerU\models\modelscope,不会重新下载)
```bash
export MINERU_MODEL_SOURCE=modelscope MODELSCOPE_CACHE="D:/MinerU/models/modelscope"
cd /d/MinerU && ./venv/Scripts/mineru.exe -p test-page31.pdf -o out-gpu -b pipeline
```
CPU 基线:单页约 50s(layout 39s+公式 8s+OCR 5s,含首次模型加载)。GPU 期望整体 <15s。
对比 CPU 版输出 `out/test-page31/auto/test-page31.md`,内容应一致。

### 2.3 引擎策略(重要)
DeepTutor 的 PDF 解析引擎是**全局开关**(`data/user/settings/document_parsing.json` 的 `engine` 字段,当前 `pymupdf4llm`):
- **日常保持 `pymupdf4llm`**(秒级,喂 KB 够用)
- 公式密集的书要进 KB 时,临时把 `engine` 改为 `mineru` → `kb create/add` → **改回 `pymupdf4llm`**
- MinerU 引擎已接好:`local_cli_path = D:/MinerU/venv/Scripts/mineru.exe`,模型源 modelscope,start.bat 已带 `MINERU_MODEL_SOURCE` / `MODELSCOPE_CACHE`
- 可选:重解析 DeGroot 全本喂 KB,GPU 下预计 1-2h 后台跑,公式变 LaTeX,数学问答质量再上一档(做完任务 1 后收益更大)

### 回滚
`uv pip install --python ... torch==<旧版>`(旧版号见 `uv pip show torch` 记录,先查再升);engine 字段改回 `pymupdf4llm`。

---

## 完成定义
- [ ] bge-m3:ollama list 有、两条 kb search 双语命中、kb list 双 ready
- [ ] MinerU:torch.cuda.is_available()=True、单页 GPU 冒烟 <15s、engine 策略不变
- [ ] 完成后更新本文件勾选框 + LEARNING_PLAN.md(如有变化)+ git commit
