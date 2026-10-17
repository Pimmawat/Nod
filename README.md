# Nod

ส่วนขยายสำหรับ **Codex Chat และ Claude Code ใน IDE** ที่ตั้งค่า hooks อัตโนมัติ ส่งเสียงเตือนเมื่อมีคำขออนุมัติหรือคำถามจากเครื่องมือที่รองรับ และอนุมัติคำขอใช้เครื่องมือที่ตั้งไว้หลังหน่วง 3 วินาที

ใช้ native hooks ของแต่ละ Agent ไม่ต้องเปิด Agent ใน Terminal และไม่อ่านหน้าจอหรือกดปุ่มผ่าน DOM การแจ้งเตือนระบุว่าเป็น Codex หรือ Claude Code

## สิ่งที่ทำได้

| เหตุการณ์ | เสียงและการแจ้งเตือน | Auto Approve |
| --- | --- | --- |
| Codex / Claude Code ขออนุมัติใช้เครื่องมือ (`PermissionRequest`) | ได้ เมื่อ Agent ส่ง hook | ได้ สำหรับเครื่องมือที่ตั้งไว้แยกตาม Agent |
| Codex ถามผ่าน `request_user_input` / `request_user_input_async` | ได้ เมื่อรุ่นและเส้นทางของเครื่องมือนั้นส่ง `PreToolUse` | ผู้ใช้เลือกคำตอบเอง |
| Claude Code ถามตัวเลือกผ่าน `AskUserQuestion` | ได้ ผ่าน `PreToolUse` | ผู้ใช้เลือกคำตอบเอง |
| ถามเป็นข้อความธรรมดาในแชท | ยังตรวจจับไม่ได้ | ไม่รองรับ |

ตั้งแต่รุ่น 0.5.0 VS Code, Antigravity และ IDE ที่รองรับ VSIX ใช้ registry กลางที่ `~/.agent-alert` จึงเปิดหลาย IDE พร้อมกันได้โดยไม่เขียน hook ทับให้เชื่อมต่อได้เพียง IDE ล่าสุด แต่ละเหตุการณ์จะถูกส่งไปยังหน้าต่างที่เปิด workspace ตรงกับ `cwd` ของ Agent และรองรับทั้ง Codex กับ Claude Code พร้อมกัน รุ่น 0.6.0 เปลี่ยนชื่อที่แสดงเป็น **Nod** โดยคง extension ID และ settings `agentAlert.*` เดิมเพื่อให้อัปเกรดต่อเนื่องโดยค่าที่ตั้งไว้ไม่หาย

การติดตั้งใหม่จะเปิดเสียงและ Auto Approve พร้อมตั้งค่า hooks ให้ Agent ที่พบใน IDE เมื่อเปิดโฟลเดอร์บนเครื่องที่เชื่อถือแล้ว ถ้ากด **Stop Auto Approve** จะจำสถานะหยุดของ workspace นั้นแม้ reload IDE จนกว่าจะสั่ง Arm อีกครั้ง คำขอที่กำลังรอจะถูกยกเลิกเมื่อกด Stop, ปรับการตั้งค่า, เปลี่ยน workspace หรือการเชื่อมต่อจบลง

ถ้าอัปเกรดจากรุ่นเก่า ส่วนขยายจะรักษาค่าที่ผู้ใช้ตั้งไว้ เช่น `autoApprove.enabled: false` หรือรายการเครื่องมือ `[]` จึงต้องเปิดค่าที่เคยปิดไว้ก่อนหากต้องการใช้ Auto Approve

## ติดตั้ง

ต้องมี IDE ที่รองรับ VS Code extension API 1.96.2+, Node.js 18+ ใน PATH ของ IDE และส่วนขยาย Agent ที่ต้องการใช้งาน: `openai.chatgpt` สำหรับ Codex หรือ `anthropic.claude-code` สำหรับ Claude Code โดยใช้รุ่นที่รองรับ native hooks ส่วนขยายจะค้นหา path เต็มของ Node เพื่อให้ hook ไม่ต้องพึ่ง PATH ของ Agent

1. ติดตั้ง `agent-alert-0.6.0.vsix` ใน **ทุก IDE ที่ต้องการใช้พร้อมกัน** จาก Extensions → `…` → **Install from VSIX…** Nod จะสั่ง Reload Window ให้อัตโนมัติหนึ่งครั้งเมื่อ IDE โหลดรุ่นใหม่แล้ว หากหน้าติดตั้งยังแสดงปุ่ม Reload ก่อนที่ extension จะเริ่มทำงาน ให้กดปุ่มนั้นหนึ่งครั้ง
2. เปิดโฟลเดอร์โปรเจกต์บนเครื่องและเชื่อถือ workspace ส่วนขยายจะตั้งค่า hooks ของ Agent ที่ติดตั้งอยู่ พร้อมเริ่ม Auto Approve ตามค่าเริ่มต้น ไม่ต้องกด Setup หรือ Arm เอง
3. ถ้าเปิด Agent ค้างไว้ ให้เริ่ม session ใหม่เพื่อโหลด hooks สำหรับ **Codex ยังต้อง review/trust hook ใหม่** ตามหน้าจอของ Codex หาก IDE ไม่มีหน้าจอจัดการ hooks ให้ใช้ `/hooks` ใน Codex CLI ที่ใช้ configuration directory เดียวกัน

Status bar จะแสดง **Auto armed** เมื่อพร้อมอนุมัติตามรายการ แต่ยังไม่ได้ยืนยันว่า Agent ส่ง hook จริงแล้ว หากแสดง **Setup needed** ให้เปิด **Nod: Show Connection Status** เพื่อดูสาเหตุ เช่นหา Node.js ไม่พบหรือ configuration อ่านไม่ได้

ตรวจเสียงด้วย **Nod: Test Sound** และลอง **Test Chat Notification** (Codex) หรือ **Test Claude Code Chat Notification** จากนั้นตรวจเหตุการณ์จริงด้วย **Show Connection Status** ซึ่งแสดงสถานะของแต่ละ Agent แยกกัน การทดสอบแจ้งเตือนจำลองไม่ยืนยันว่า hook ของ Agent ทำงานแล้ว

หากต้องการจัดการ hooks เอง ให้ปิด `agentAlert.setup.automatic` คำสั่ง **Set Up Codex Chat Hooks**, **Set Up Claude Code Chat Hooks** และ **Preview … Hook Configuration** ยังใช้ได้จาก Command Palette

### เชื่อม Claude Code

ส่วนขยายจะ merge hooks ลงใน `~/.claude/settings.json` อัตโนมัติ โดยเก็บ settings, permissions, plugins และ hooks เดิมไว้ พร้อมสำรองไฟล์เดิมก่อนเปลี่ยนแปลง ถ้าใช้ `CLAUDE_CONFIG_DIR` หรือ `agentAlert.claudeHome` จะใช้ directory นั้นแทน เรียก **Nod: Set Up Claude Code Chat Hooks** ได้หากต้องการตั้งค่าเอง

ใช้ **Nod: Preview Claude Code Hook Configuration** เพื่อดู JSON หรือ merge เองได้ การตั้งค่า hooks ไม่เปลี่ยน `disableAllHooks` หรือ permission mode ที่ตั้งไว้ ถ้าปิด hooks ใน Claude Code อยู่ ต้องเปิดก่อน

หลัง Setup ให้เริ่ม Claude Code session ใหม่ แล้วตรวจ hooks ที่โหลดในเมนู Hooks ของ Claude Code รุ่นที่มีเมนูนี้ หรือ `/hooks` ใน CLI ที่ใช้ configuration เดียวกัน ดู [hooks ในส่วนขยาย VS Code](https://code.claude.com/docs/en/vs-code#use-the-prompt-box)

ทดสอบ choice จริงโดยส่งใน **แชท Claude Code** ว่า: `ใช้ AskUserQuestion ถามฉันว่าจะเลือก TypeScript หรือ JavaScript แล้วรอคำตอบ` เมื่อ Claude เรียกเครื่องมือนี้ ส่วนขยายควรส่งเสียงและแจ้งเตือน จากนั้นตรวจ **Show Connection Status** ว่าได้รับ Claude Code question จริงแล้ว ปุ่ม Test Notification เป็นเพียงการจำลองและไม่เพิ่มสถานะว่าได้รับ hook จริง

### เชื่อม Codex

ส่วนขยายจะรวม hook ลงใน `~/.codex/hooks.json` อัตโนมัติ โดยเก็บ hook เดิมไว้ และสำรองไฟล์เดิมก่อนเปลี่ยนแปลง ถ้าใช้ `CODEX_HOME` หรือ `agentAlert.codexHome` จะใช้ directory นั้นแทน

ใช้ `Nod: Preview Codex Hook Configuration` เพื่อดู JSON ก่อน หรือคัดลอกไป merge เองได้ ใน configuration ที่ปิด hooks ต้องเปิด `[features] hooks = true` ด้วย

Codex กำหนดให้ review/trust **นิยาม hook ที่ตรงกันทุกครั้ง** เมื่อเพิ่มหรือเปลี่ยน hook ส่วนขยายจึงไม่สามารถข้ามขั้นตอนนี้ให้ได้ ดู [เอกสารการ trust hooks ของ OpenAI](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

ตั้งแต่รุ่น 0.5.0 helper และ endpoint registry อยู่ใน `~/.agent-alert` ซึ่งเป็น path กลางของทุก IDE และไม่ผูกกับโฟลเดอร์เลขรุ่นของ VSIX เมื่ออัปเกรดจากรุ่นเก่า path จะเปลี่ยนครั้งแรกและ Codex จะต้อง review/trust hook ใหม่ หากภายหลังเปลี่ยน path ของ Node, `agentAlert.sharedDataDirectory` หรือ configuration จนคำสั่ง hook เปลี่ยน ก็ต้อง trust ใหม่เช่นกัน

## ควบคุม Auto Approve

1. รายการเริ่มต้นของ Codex คือ `Bash`, `exec_command`, `apply_patch` ส่วน Claude Code คือ `Bash`, `Edit`, `Write` แก้ได้ใน `agentAlert.autoApprove.allowedTools` และ `agentAlert.autoApprove.claudeAllowedTools`
2. เมื่อเกิดคำขอที่ตรงกับรายการ จะเตือนก่อนแล้วส่งผลอนุมัติหลัง 3 วินาที คำถามแบบ choice ยังต้องเลือกคำตอบเอง
3. กด **Stop Auto Approve** ในการแจ้งเตือนหรือเมนู Nod เพื่อหยุดและยกเลิกคำขอที่รออยู่ สถานะหยุดจะจำไว้สำหรับ workspace นี้หลังเปิด IDE ใหม่
4. เมื่อต้องการเปิดอีกครั้ง เลือก **Arm Auto Approve in this window** หรือเรียก **Nod: Toggle Auto Approve in This Window**

ตั้ง `agentAlert.autoApprove.enabled` เป็น `false` เพื่อใช้เฉพาะเสียงและการแจ้งเตือน หรือตั้ง `agentAlert.autoApprove.armOnStartup` เป็น `false` หากต้องการ Arm เองทุกครั้งหลัง reload IDE การ Pause จะหยุดทั้งเสียงและการอนุมัติ และจำสถานะ Pause ของ workspace ไว้ด้วย

การ Arm หน้าต่างมีผลกับรายการเครื่องมือที่ตั้งไว้ของทั้งสอง Agent รายการ Codex ไม่มีผลต่อ Claude Code ถ้าต้องการ Auto Approve เฉพาะ Claude ให้ตั้งรายการ Codex เป็น `[]`

`Bash` และ `exec_command` หมายถึงอนุมัติ **ทุกคำสั่ง shell ที่ขอสิทธิ์ผ่านเครื่องมือชื่อนั้น** ไม่ได้กรองข้อความคำสั่ง ส่วน `*` ครอบคลุมทุกชื่อเครื่องมือของ Agent นั้น ยกเว้นเครื่องมือถามคำตอบ เช่น `AskUserQuestion` ที่ต้องให้ผู้ใช้ตอบเอง กฎ/managed policy และ hook อื่นของ Agent ยังมีผล สำหรับ Claude การอนุมัติแผน `ExitPlanMode` เป็นคำขออนุมัติ จึงเข้าข่ายเมื่อระบุชื่อนี้หรือ `*`

| Setting | ค่าเริ่มต้น | ใช้ทำอะไร |
| --- | --- | --- |
| `agentAlert.enabled` | `true` | เปิดรับเหตุการณ์ |
| `agentAlert.setup.automatic` | `true` | ตั้งค่า hooks ของ Agent ที่ติดตั้งอยู่เมื่อเปิด workspace บนเครื่องที่เชื่อถือ |
| `agentAlert.sound.enabled` | `true` | เปิดเสียง |
| `agentAlert.sound.file` | `""` | path เต็มของไฟล์เสียงที่เลือก; ว่างคือเสียงที่มากับส่วนขยาย |
| `agentAlert.notifications.enabled` | `true` | เปิดการแจ้งเตือนใน IDE |
| `agentAlert.autoApprove.enabled` | `true` | เปิด master setting ของการอนุมัติอัตโนมัติ |
| `agentAlert.autoApprove.armOnStartup` | `true` | Arm เมื่อเปิดหน้าต่าง ยกเว้น workspace ที่กด Stop ไว้ |
| `agentAlert.autoApprove.allowedTools` | `["Bash", "exec_command", "apply_patch"]` | ชื่อเครื่องมือ Codex ที่อนุมัติได้ ตรงตัวหรือ `*` |
| `agentAlert.autoApprove.claudeAllowedTools` | `["Bash", "Edit", "Write"]` | ชื่อเครื่องมือ Claude Code ที่อนุมัติได้ ตรงตัวหรือ `*`; `[]` คือไม่อนุมัติ |
| `agentAlert.autoApprove.delayMs` | `3000` | หน่วงก่อนอนุมัติ 1–30 วินาที |
| `agentAlert.sharedDataDirectory` | `""` | directory กลางสำหรับประสานหลาย IDE; ค่าว่างใช้ `~/.agent-alert` และต้องใช้ค่าเดียวกันทุก IDE |
| `agentAlert.codexHome` | `""` | directory การตั้งค่า Codex แบบกำหนดเอง |
| `agentAlert.claudeHome` | `""` | directory การตั้งค่า Claude Code แบบกำหนดเอง |

## เปลี่ยนเสียงเป็นไฟล์ของคุณ

1. กด **Nod** บน status bar → **Choose alert sound…** หรือเรียก **Nod: Choose Alert Sound** จาก Command Palette
2. เลือกไฟล์เสียงบนเครื่อง ส่วนขยายจะบันทึก path และเล่นตัวอย่างให้ฟัง
3. เสียงที่เลือกจะใช้กับการแจ้งเตือนของทั้ง Codex และ Claude Code ทันที และจำไว้หลังเปิด IDE ใหม่

macOS เลือก WAV, MP3, M4A, AIFF ได้ ส่วน Windows/Linux ใช้ WAV (แนะนำ PCM) เล่นได้สูงสุด 5 วินาทีต่อครั้ง จึงเหมาะกับคลิปเสียงสั้น ๆ ปุ่ม **Test Sound** จะเล่นเสียงที่ตั้งไว้ หากปิด `agentAlert.sound.enabled` ไว้ ต้องเปิดเพื่อให้มีเสียงเมื่อแจ้งเตือน

ใช้ **Nod: Restore Built-in Sound** เพื่อกลับไปใช้เสียงเดิม หรือกำหนด `agentAlert.sound.file` เป็น path เต็มใน Settings ได้ หากย้าย/ลบไฟล์ หรือเครื่องเล่นอ่านไฟล์ไม่ได้ จะใช้เสียงเดิมแทนและบันทึกเหตุผลใน **Show Log** ส่วนขยายอ้างอิงไฟล์ที่เลือกโดยตรง จึงควรเก็บไฟล์ไว้ในตำแหน่งเดิม

## ขอบเขตการรองรับ

- รุ่นนี้รองรับ **workspace บนเครื่องเดียวกับ IDE** ยังไม่รองรับ SSH, containers, WSL หรือ Agent ที่รันบนเครื่องอื่น
- ใช้กับ VS Code และ IDE ที่รองรับ VSIX เช่น Antigravity ได้ตาม API ของ IDE นั้น แต่ยังไม่ได้ทดสอบหน้าจอจริงครบทุก IDE
- OpenAI ระบุว่า local function tools ส่วนใหญ่ส่ง `PreToolUse` แต่บางเส้นทางอาจไม่ส่ง จึงต้องยืนยันเหตุการณ์คำถามกับ Codex รุ่นที่ใช้อยู่ การทดสอบแจ้งเตือนจำลองไม่ได้ยืนยันว่า hook จริงทำงานแล้ว
- Claude ในที่นี้คือ **Claude Code** ที่มี native hooks ไม่ใช่แชทบน claude.ai หรือแชททั่วไปในแอป Claude
- ใช้ hooks ระดับผู้ใช้ จึงรับเหตุการณ์จาก Claude Code CLI ที่ใช้ configuration เดียวกันและทำงานใน workspace ที่เปิดอยู่ด้วย
- Claude Code บาง prompt เช่นการขอ network ของ sandbox ไม่ส่ง `PermissionRequest` รุ่นนี้ยังไม่รับ `Notification` จึงไม่ครอบคลุม prompt เหล่านั้น ดู [ข้อจำกัด PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest)
- เปิด VS Code และ Antigravity พร้อมกันได้ แม้ใช้ configuration ของ Agent ชุดเดียวกัน โดยทุก IDE ต้องติดตั้งรุ่น 0.5.0+ และใช้ `agentAlert.sharedDataDirectory` เดียวกัน (ค่าเริ่มต้นตรงกันอยู่แล้ว)
- หากเปิดโปรเจกต์เดียวกันหลายหน้าต่าง เหตุการณ์คำถามจะกระจายไปยังหน้าต่างที่ตรงกัน ส่วนคำขออนุมัติจะหยุดทันทีเมื่อหน้าต่างหนึ่งอนุมัติได้ จึงอาจเห็น notification ซ้ำในกรณีที่หน้าต่างแรกตั้งเป็น Alerts only
- ถ้า IDE ปิดอยู่หรือไม่มี workspace ตรงกัน hook จะออกโดยไม่ตัดสินใจ และ Agent ใช้ขั้นตอนอนุมัติปกติ
- คำขอ Auto Approve จะรอใน hook ก่อนแสดง prompt ปกติของ Agent; ถ้ากด Stop จะคืนให้ Agent ถามตามปกติ

เสียงเล่นบนเครื่องผู้ใช้: macOS ใช้ `afplay`, Windows ใช้ PowerShell `SoundPlayer`, Linux ใช้ `paplay` หรือ `aplay` หากไม่ดัง ให้ตรวจ `Nod: Show Log` และอุปกรณ์เสียง

## วิธีทำงาน

```text
Codex / Claude Code Chat → Native hook → Node helper → Local Nod
                                                        ├─ เล่นเสียง / แจ้งเตือน
                                                        └─ คืน allow ตามรายการของ Agent นั้น
```

Helper ส่งเฉพาะชื่อ Agent ชนิดเหตุการณ์ ชื่อเครื่องมือ session/request ID และ cwd ไปยัง `127.0.0.1` พร้อม token ต่อหน้าต่าง ไม่ส่ง tool arguments หรือเนื้อหาบทสนทนา ไฟล์ connection บน POSIX อ่านได้เฉพาะผู้ใช้ มีอายุ 5 นาทีและ refresh ทุก 15 วินาทีเพื่อทนต่อ sleep/การสะดุดชั่วคราว endpoint ที่ตายจะถูกข้ามไปยัง IDE ที่ตรงกันตัวถัดไป และไฟล์เก่าจะถูกเก็บกวาดอัตโนมัติ ไม่มี telemetry ตัวส่ง Claude จะไม่ส่งคำขอไปยังส่วนขยายรุ่นเก่าที่รองรับเพียง Codex

ใช้ [PermissionRequest](https://learn.chatgpt.com/docs/hooks#permissionrequest) สำหรับคำขออนุมัติ และ [PreToolUse / tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage) สำหรับคำถามที่รองรับ ส่วนขยายไม่จำเป็นต้องเข้าถึง webview ของ Codex

Claude Code ใช้ [PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest) และ [PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse) โดย matcher คำถามคือ `^AskUserQuestion$` ตอบกลับด้วย native hook decision เฉพาะคำขออนุมัติใช้เครื่องมือ

## พัฒนาและทดสอบ

```sh
npm ci
npm test
npm run package
```

กด **F5** เพื่อเปิด Extension Development Host การเปิด workspace ที่เชื่อถือจะตั้งค่า hooks อัตโนมัติด้วย หากต้องการแยกจาก configuration ที่ใช้งานจริง ให้ปิด `agentAlert.setup.automatic` หรือตั้ง `agentAlert.codexHome` และ `agentAlert.claudeHome` ไปยัง directory สำหรับพัฒนา

การทดสอบอัตโนมัติใช้ fixture และ localhost ไม่เล่นเสียงหรือเปลี่ยน configuration ของ Agent จริง ครอบคลุมการตั้งค่าเมื่อเปิดใช้ครั้งแรก, การติดตั้ง Agent ภายหลัง, workspace trust, Node ที่หาไม่พบ, configuration เสีย, การจำ Stop หลัง reload, hook subprocess ของทั้งสอง Agent, การแยกรายการอนุมัติ, การเลือก workspace, token, timeout, การ merge configuration และเสียงแบบจำลอง ยังต้องยืนยันการทำงานกับหน้าจอ Agent จริงบนเครื่องที่นำไปติดตั้ง

## ถอนการเชื่อมต่อ

Pause/Disable ส่วนขยายเพื่อหยุดการทำงาน แล้วลบเฉพาะ command hook ที่มี `--agent-alert-codex` ออกจาก Codex `hooks.json` หรือ `--agent-alert-claude` ออกจาก Claude Code `settings.json` เก็บ settings และ hooks ของเครื่องมืออื่นไว้ หากยังเปิดส่วนขยายอยู่ ให้ปิด `agentAlert.setup.automatic` ด้วยเพื่อไม่ให้เพิ่ม hooks กลับ เมื่อไม่ได้เปิดส่วนขยาย helper จะไม่ออกผลอนุมัติ
