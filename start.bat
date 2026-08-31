@echo off
cd /d D:\DeepTutor
set MINERU_MODEL_SOURCE=modelscope
set MODELSCOPE_CACHE=D:\MinerU\models\modelscope
echo Starting DeepTutor (backend 8001 / frontend http://localhost:3782) ...
venv\Scripts\deeptutor.exe start
