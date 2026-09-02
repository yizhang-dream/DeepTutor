@echo off
cd /d D:\DeepTutor
set MINERU_MODEL_SOURCE=modelscope
set MODELSCOPE_CACHE=D:\MinerU\models\modelscope
rem MinerU CLI 内部默认 3600s 任务超时,大扫描书(GPU ~50min)会被掐,放到 4h
set MINERU_TASK_RESULT_TIMEOUT_SECONDS=14400
echo Starting DeepTutor (backend 8001 / frontend http://localhost:3782) ...
venv\Scripts\deeptutor.exe start
