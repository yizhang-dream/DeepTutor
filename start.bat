@echo off
cd /d D:\DeepTutor
set MINERU_MODEL_SOURCE=modelscope
set MODELSCOPE_CACHE=D:\MinerU\models\modelscope
rem MinerU CLI 内部默认 3600s 任务超时,大扫描书(GPU ~50min)会被掐,放到 4h
set MINERU_TASK_RESULT_TIMEOUT_SECONDS=14400
echo Starting DeepTutor (backend 8001 / frontend http://localhost:3782) ...
rem `deeptutor start` 的后端子进程走 deeptutor.api.run_server 加固入口（Windows 强制 ProactorEventLoop），不要再改回裸 python -m uvicorn
venv\Scripts\deeptutor.exe start
