# DeepTutor 学习工作流方案

> 2026-08-30 定稿。工具:DeepTutor(D:\DeepTutor,前端 http://localhost:3782)+ 日程志(Plan APP)+ 外部 TPO/跟读。
> 启动:双击 `D:\DeepTutor\start.bat`。

## 一、四线结构与优先级

| 线 | 定位 | 每天 |
|---|---|---|
| **RL/具身智能** | 主线,配 GR00T 与 sts_ppo 项目 | 2h |
| **数学基础** | 按需配套(不单独排课) | 弹性 |
| **Python 工程** | 按需配套(不单独排课) | 弹性 |
| **托福** | 每日固定 | 1h |

## 二、每日时间表(全职强度,4h+)

| 时段 | 内容 |
|---|---|
| 第 1 块 90min | **RL 精读**:Sutton & Barto 当章(Book 逐页 + teacher 苏格拉底追问) |
| 缓冲 15min | 休息 |
| 第 2 块 60min | **RL 实践**:HF Deep RL Course 对应单元代码 / sts_ppo 项目联运 |
| 缓冲 15min | 休息 |
| 第 3 块 60min | **托福**:听力 30(TPO 真题,外部)+ 口语 15(跟读/TPO 口题,外部)+ 词汇 15(DeepTutor 词卡听写) |
| 弹性 ≥30min | **数学/Python 按需**(见第四节规则)+ teach-back 写作(按章) |

规则:高认知块放精力黄金期(上午优先);块间必须留缓冲;当晚写次日清单(丢给日程志 AI 生成)。

## 三、RL 主线(2h/天)

### 1. 教材主线
- **Sutton & Barto《Reinforcement Learning: An Introduction》2nd**(PDF 放 `D:\DeepTutor\books\` 后用 Book 导入,逐章精读)
- 进度基准:平均 **1 章/1.5-2 周**(全职下 13 章约 3-4 个月走完)
- 顺序:1-6 章(表格法)→ 9-13(策略梯度/AC,直通 PPO)→ 7-8(按需回补)→ 后续按 GR00T 需要选读

### 2. 代码实践线
- HF Deep RL Course(已挂为 DeepTutor 网页知识源,自动同步):每章配对单元,跑通 Gymnasium 环境
- sts_ppo 项目:学到对应概念( advantage/clip/entropy)就回项目看实现

### 3. 知识库(已建)
- `rl-core` KB:你的 `Reinforcement-Learning-Study-Note`(中文逐章笔记+notebook)已导入——精读卡壳时先问它,它用你熟悉的中文讲法对照
- HF course 网页源已挂,自动同步

### 4. 论文追踪(每周)
- 方向:VLA/具身操作、PPO 及其改进、世界模型、奖励设计
- 节奏:每周跑一次 `deep_research` 汇总领域动态(周中)+ 周末从汇总里**精读 1 篇**(含复述)
- 精读产出并入 teach-back 流程

## 四、按需学习规则(数学/Python)

不排课,规则触发:
- RL 中遇到看不懂的数学概念 → 当场 `deep_question` 问到懂为止(它负责补线代/概率/微积分前置)
- 写代码卡壳/报错 → `deep_solve` 或 Chat 解决,顺手让它讲背后的 Python/工程范式
- 判据:一个概念被问 3 次以上 → 升级为专项小节,单独排进弹性时段

### 概率统计教材线(2026-08-31 加入)

课程用书 5 本(PDF 目标目录 `D:\DeepTutor\books\prob-stats\`,**待下载导入**):

| # | 教材 | 角色 |
|---|---|---|
| 1 | Ross《概率论基础教程》第7版(中文) | **入门主线**:直觉+例题驱动,先快速过概率部分(Ch1-8) |
| 2 | DeGroot & Schervish, *Probability and Statistics* 4e | **精读主线**:概率+统计全覆盖,Book 导入逐章精读+teach-back |
| 3 | Hogg & Craig, *Introduction to Mathematical Statistics* 5e | 统计深化:数理统计部分(估计/检验/渐近)按需查阅 |
| 4 | Linde, *Probability Theory* | 测度论视角的紧凑复习,二刷用 |
| 5 | Panaretos, *Statistics for Mathematicians* | 高观点统计,进阶选读 |

用法:Ross(中文,快)+ DeGroot(英文精读,协同英语)双主线的顺序——先 Ross 建直觉,再 DeGroot 对应章严谨化;Hogg/Craig/Linde/Panaretos 当参考书不逐章读。RL 关联重点:条件期望、常见分布、期望/方差运算、大数定律与中心极限定理(直接服务 RL 理论)。

## 五、验收:teach-back(每章)

1. 章读完后,写一篇讲解(装作教一个完全不懂的人)
2. 语言:**前两章中文,第 3 章起固定英文**(同时练托福写作)
3. 批改 prompt(发给 DeepTutor):
   > 这是我的章节 teach-back。请双重批改:(1)教学准确性——指出理解错误、遗漏的关键概念、似是而非的表述;(2)语言质量——语法/用词/学术表达问题。最后按 10 分制打分,<8 分请列出你必须追问我的三个问题。
4. 追问答不上 → 回 Book 重读对应页,补完再交

## 六、托福(1h/天)

- 听力 30min:TPO 真题(外部软件/网站),错题文本可丢给 DeepTutor 分析
- 口语 15min:跟读/TPO 口题(外部),录音自评
- 词汇 15min:DeepTutor 词卡听写(让它每天出 20 个学术词+例句,昨天错的今天重出)
- 读写:不单独练——英文教材精读=阅读,英文 teach-back=写作

## 七、第一周逐日日程(可粘给日程志 AI 生成)

Day 1(周一):环境日——放 Sutton & Barto PDF 进 `D:\DeepTutor\books\` 并导入 Book;建 Learning Space 课程(RL/数学/Python/托福);HF Unit 0 跑通;托福 TPO 一套听力摸底;DeepTutor 出第一份词卡
Day 2(周二):Sutton & Barto Ch1 精读(上)1.1-1.3;HF Unit 1(上);托福听力 30+词卡 15
Day 3(周三):Ch1 精读(下)1.4-1.5;HF Unit 1(下);托福听力 30+口语 15+词卡 15;**中文 teach-back:Ch1**
Day 4(周四):Ch2 动态规划精读(上)策略迭代;HF Unit 2(上);托福听力+词卡
Day 5(周五):Ch2 精读(下)价值迭代;HF Unit 2(下);托福听+说+词卡;**中文 teach-back:Ch2**(切换点:下一章起英文)
Day 6(周六):deep_research 第一次跑(VLA/PPO 改进/世界模型)→ 挑 1 篇精读;补弹性数学/Python;轻量托福(听力 30)
Day 7(周日):复盘周——重读两条 teach-back 批改,整理薄弱清单;sts_ppo 里找本周概念的对应实现;休息

## 八、日程志合并

- 每晚把次日任务清单(本方案的当日块)粘给日程志 AI,按 `SCHEDULE_RULES.md` 生成单日日程
- 本方案的固定块(RL 2h/托福 1h)作为 tasks 里的 daily 型任务,constraint 按精力规则标注
- 生成的 schedule JSON 由日程志自身保存,DeepTutor 不管日程

## 九、初始化清单

- [x] DeepTutor 部署+模型配置(DeepSeek 官方,embedding=Ollama nomic-embed-text)
- [x] socratic-tutor 技能 + teacher persona
- [x] rl-core 知识库(RL-Study-Note 已导入)
- [x] HF Deep RL Course 网页源已挂
- [ ] **Sutton & Barto PDF 下载后放 `D:\DeepTutor\books\` 并导入 Book**(用户动作)
- [ ] **概率统计 5 本 PDF 放 `D:\DeepTutor\books\prob-stats\` 并导入 Book**(Ross 中文版先导,DeGroot 精读)
- [ ] Learning Space 建 4 个课程(RL/数学/Python/托福)
- [ ] 日程志里把 4h 学习块建成 daily 任务
