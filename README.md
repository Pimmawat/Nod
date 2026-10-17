<p align="center">
  <img src="https://raw.githubusercontent.com/Pimmawat/Nod/main/assets/icon.png" width="128" height="128" alt="Nod logo">
</p>

<h1 align="center">Nod</h1>

<p align="center">
  <strong>รับการแจ้งเตือนจาก Codex และ Claude Code พร้อมควบคุม Auto Approve ได้จาก IDE</strong>
</p>

<p align="center">
  Native hooks · Local only · Multi-IDE · No telemetry
</p>

Nod เป็นส่วนขยายสำหรับ VS Code และ IDE ที่รองรับ VSIX ช่วยส่งเสียงและแสดงการแจ้งเตือนเมื่อ Codex หรือ Claude Code ต้องการสิทธิ์ใช้เครื่องมือหรือถามคำถามที่รองรับ โดยเชื่อมต่อผ่าน native hooks ของแต่ละ Agent โดยตรง ไม่อ่านหน้าจอ ไม่กดปุ่มผ่าน DOM และไม่จำเป็นต้องเปิด Agent ใน Terminal

## จุดเด่น

- **รองรับ Codex และ Claude Code** — แยกสถานะ การแจ้งเตือน และรายการ Auto Approve ของแต่ละ Agent
- **ตั้งค่า hooks อัตโนมัติ** — merge เข้ากับ configuration เดิม พร้อมสร้างไฟล์สำรองก่อนเปลี่ยนแปลง
- **แจ้งเตือนทันที** — ใช้เสียงที่มากับส่วนขยายหรือเลือกไฟล์เสียงของคุณเอง
- **ใช้งานหลาย IDE พร้อมกัน** — ส่งเหตุการณ์ไปยังหน้าต่างที่เปิด workspace ตรงกับ `cwd` ของ Agent
- **ทำงานบนเครื่องเท่านั้น** — bridge รับการเชื่อมต่อผ่าน `127.0.0.1` และไม่มี telemetry
- **ควบคุมได้ตลอดเวลา** — หยุด Auto Approve, Pause ทั้งระบบ หรือยกเลิกคำขอที่กำลังรอได้จาก status bar

## รองรับเหตุการณ์ใดบ้าง

| เหตุการณ์ | เสียงและ Notification | Auto Approve |
| --- | :---: | :---: |
| Codex / Claude Code ขอใช้เครื่องมือ (`PermissionRequest`) | ✓ | ✓ สำหรับเครื่องมือที่กำหนด |
| Codex เรียก `request_user_input` / `request_user_input_async` | ✓ เมื่อ Agent ส่ง `PreToolUse` | — |
| Claude Code เรียก `AskUserQuestion` | ✓ | — |
| Agent ถามเป็นข้อความธรรมดาในแชท | — | — |

> [!IMPORTANT]
> การติดตั้งใหม่จะเปิด Auto Approve ตามค่าเริ่มต้นสำหรับ `Bash`, `exec_command`, `apply_patch` ของ Codex และ `Bash`, `Edit`, `Write` ของ Claude Code หลังหน่วง 3 วินาที รายการนี้ตรวจจาก **ชื่อเครื่องมือ** ไม่ได้วิเคราะห์ข้อความคำสั่งภายใน หากต้องการใช้เฉพาะการแจ้งเตือน ให้ปิด `agentAlert.autoApprove.enabled` ทันทีหลังติดตั้ง

## เริ่มต้นใช้งาน

### สิ่งที่ต้องมี

- VS Code หรือ IDE ที่รองรับ VS Code Extension API `1.96.2` ขึ้นไป
- Node.js `18` ขึ้นไปใน `PATH` ของ IDE
- Agent อย่างน้อยหนึ่งตัวที่รองรับ native hooks:
  - Codex extension: `openai.chatgpt`
  - Claude Code extension: `anthropic.claude-code`

### ติดตั้งจาก VSIX

1. ดาวน์โหลด `agent-alert-0.6.0.vsix`
2. เปิดหน้า **Extensions** ใน IDE แล้วเลือก `…` → **Install from VSIX…**
3. เปิดโฟลเดอร์โปรเจกต์บนเครื่องและ Trust workspace
4. รอให้ Nod ตั้งค่า hooks อัตโนมัติ แล้วเริ่ม Agent session ใหม่
5. สำหรับ Codex ให้ review/trust hook ที่เพิ่มใหม่ตามหน้าจอของ Codex หรือผ่าน `/hooks`

ติดตั้ง Nod ในทุก IDE ที่ต้องการเปิดใช้งานพร้อมกัน ส่วนขยายจะ reload หน้าต่างหนึ่งครั้งเมื่อพบว่าเป็นการติดตั้งหรืออัปเดตเวอร์ชันใหม่ หาก IDE ยังแสดงปุ่ม **Reload** ให้กดปุ่มนั้นอีกครั้ง

### ตรวจสอบว่าพร้อมใช้งาน

กด **Nod** บน status bar แล้วทดสอบตามลำดับนี้:

1. **Test sound** — ตรวจสอบเสียงจากระบบ
2. **Test Codex chat notification** หรือ **Test Claude Code chat notification** — ตรวจสอบ Notification จำลอง
3. **Connection status** — ตรวจสอบว่าได้รับ hook จริงจาก Agent หรือยัง

Notification จำลองยืนยันเฉพาะการแสดงผลของ Nod ไม่ได้ยืนยันว่า Agent โหลด hook สำเร็จ ต้องเรียกเครื่องมือจริงจาก Agent แล้วตรวจ **Connection status** อีกครั้ง

## สถานะบน Status Bar

| สถานะ | ความหมาย |
| --- | --- |
| **Auto armed** | พร้อมอนุมัติเครื่องมือที่อยู่ในรายการ Auto Approve |
| **Alerts only** | รับเสียงและ Notification แต่ไม่อนุมัติอัตโนมัติ |
| **Setup needed** | hook หรือ dependency มีปัญหา เปิด **Connection status** เพื่อดูรายละเอียด |
| **Paused** | หยุดทั้งการแจ้งเตือนและ Auto Approve สำหรับ workspace นี้ |
| **Disconnected** | local bridge ยังไม่พร้อมหรือเริ่มทำงานไม่สำเร็จ |

## เชื่อมต่อ Agent

Nod ตั้งค่า Agent ที่ติดตั้งอยู่ใน IDE ให้อัตโนมัติเมื่อเปิด trusted local workspace หากต้องการจัดการเอง ให้ปิด `agentAlert.setup.automatic` แล้วใช้คำสั่ง Setup หรือ Preview จาก Command Palette

### Claude Code

Nod merge hooks ลงใน `~/.claude/settings.json` โดยเก็บ settings, permissions, plugins และ hooks เดิมไว้ หากกำหนด `CLAUDE_CONFIG_DIR` หรือ `agentAlert.claudeHome` จะใช้ directory นั้นแทน

- ตั้งค่าเอง: **Nod: Set Up Claude Code Chat Hooks**
- ดู JSON ก่อนติดตั้ง: **Nod: Preview Claude Code Hook Configuration**
- ตรวจ hooks ที่โหลด: เมนู Hooks ของ Claude Code หรือ `/hooks` ใน CLI
- หลัง Setup: เริ่ม Claude Code session ใหม่

Nod ไม่แก้ `disableAllHooks` หรือ permission mode หาก `disableAllHooks` เปิดอยู่ ต้องเปิด hooks ใน Claude Code ก่อน ดู [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)

ทดสอบคำถามจริงด้วย prompt ตัวอย่าง:

```text
ใช้ AskUserQuestion ถามฉันว่าจะเลือก TypeScript หรือ JavaScript แล้วรอคำตอบ
```

### Codex

Nod merge hook ลงใน `~/.codex/hooks.json` โดยเก็บ hooks เดิมไว้ หากกำหนด `CODEX_HOME` หรือ `agentAlert.codexHome` จะใช้ directory นั้นแทน

- ตั้งค่าเอง: **Nod: Set Up Codex Chat Hooks**
- ดู JSON ก่อนติดตั้ง: **Nod: Preview Codex Hook Configuration**
- ตรวจและ Trust hooks: ใช้หน้าจอของ Codex หรือ `/hooks` ใน Codex CLI

ถ้าปิด hooks ใน Codex configuration ต้องเปิดฟีเจอร์ก่อน:

```toml
[features]
hooks = true
```

Codex กำหนดให้ผู้ใช้ review/trust นิยาม hook ที่เพิ่มหรือเปลี่ยน Nod ไม่สามารถข้ามขั้นตอนนี้ได้ ดู [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)

## Auto Approve

เมื่อ Agent ส่ง `PermissionRequest` ที่ชื่อเครื่องมือตรงกับรายการ Nod จะแจ้งเตือน รอตามค่า `agentAlert.autoApprove.delayMs` แล้วส่งผลอนุมัติกลับไป กฎ sandbox, managed policy, deny rule และ hooks อื่นของ Agent ยังมีผลตามปกติ

### ควบคุมจาก Nod

- **Stop Auto Approve** — ยกเลิกคำขอที่รออยู่และจำสถานะหยุดของ workspace หลัง reload
- **Arm Auto Approve in this window** — เปิด Auto Approve อีกครั้งสำหรับหน้าต่างปัจจุบัน
- **Pause Nod** — หยุดทั้ง Notification, เสียง และ Auto Approve
- `agentAlert.autoApprove.armOnStartup: false` — บังคับให้ Arm เองทุกครั้งหลังเปิด IDE
- `agentAlert.autoApprove.enabled: false` — ใช้ Nod สำหรับเสียงและ Notification เท่านั้น

> [!WARNING]
> `Bash` และ `exec_command` ครอบคลุมคำสั่ง shell ที่ Agent ขอสิทธิ์ผ่านเครื่องมือนั้น โดย Nod ไม่กรองข้อความคำสั่ง ส่วน `*` ครอบคลุมทุกชื่อเครื่องมือที่เป็น permission request ควรใช้เฉพาะใน workspace และสภาพแวดล้อมที่คุณเชื่อถือ

รายการของ Codex และ Claude Code แยกจากกัน หากต้องการ Auto Approve เฉพาะ Agent ตัวเดียว ให้ตั้งรายการของอีกตัวเป็น `[]` คำถาม เช่น `AskUserQuestion` และ `request_user_input` จะไม่ถูกตอบอัตโนมัติ แม้ตั้งรายการเป็น `*`

## คำสั่งหลัก

เปิด Command Palette แล้วพิมพ์ `Nod:` หรือกด **Nod** บน status bar

| คำสั่ง | ใช้ทำอะไร |
| --- | --- |
| **Open Controls** | เปิดเมนูควบคุมทั้งหมด |
| **Set Up Codex Chat Hooks** | merge hooks ลงใน Codex configuration |
| **Set Up Claude Code Chat Hooks** | merge hooks ลงใน Claude Code configuration |
| **Preview … Hook Configuration** | ดู JSON ที่ Nod จะติดตั้งโดยยังไม่แก้ไฟล์จริง |
| **Toggle Auto Approve in This Window** | Arm หรือ Stop Auto Approve |
| **Pause** | หยุดหรือเริ่ม Nod สำหรับ workspace นี้ |
| **Choose Alert Sound** | เลือกไฟล์เสียงบนเครื่อง |
| **Test Sound / Test … Notification** | ทดสอบเสียงและ Notification จำลอง |
| **Show Connection Status** | แสดง Agent, hook, workspace และสถานะการเชื่อมต่อ |
| **Show Log** | เปิด Output Channel ของ Nod |

## การตั้งค่า

| Setting | ค่าเริ่มต้น | รายละเอียด |
| --- | --- | --- |
| `agentAlert.enabled` | `true` | เปิดรับเหตุการณ์จาก Agent |
| `agentAlert.setup.automatic` | `true` | ตั้งค่า hooks อัตโนมัติใน trusted local workspace |
| `agentAlert.sound.enabled` | `true` | เปิดเสียงแจ้งเตือน |
| `agentAlert.sound.file` | `""` | absolute path ของเสียงที่เลือก; ค่าว่างใช้เสียง built-in |
| `agentAlert.notifications.enabled` | `true` | แสดง IDE Notification |
| `agentAlert.autoApprove.enabled` | `true` | เปิดระบบ Auto Approve |
| `agentAlert.autoApprove.armOnStartup` | `true` | Arm เมื่อเปิดหน้าต่าง ยกเว้น workspace ที่กด Stop ไว้ |
| `agentAlert.autoApprove.allowedTools` | `["Bash", "exec_command", "apply_patch"]` | รายการเครื่องมือ Codex ที่อนุมัติได้ |
| `agentAlert.autoApprove.claudeAllowedTools` | `["Bash", "Edit", "Write"]` | รายการเครื่องมือ Claude Code ที่อนุมัติได้ |
| `agentAlert.autoApprove.delayMs` | `3000` | เวลารอก่อนอนุมัติ ตั้งได้ 1–30 วินาที |
| `agentAlert.sharedDataDirectory` | `""` | directory กลางสำหรับหลาย IDE; ค่าว่างใช้ `~/.agent-alert` |
| `agentAlert.codexHome` | `""` | Codex configuration directory แบบกำหนดเอง |
| `agentAlert.claudeHome` | `""` | Claude Code configuration directory แบบกำหนดเอง |

ชื่อเครื่องมือต้องตรงตัว หรือใช้ `*` สำหรับทุกเครื่องมือของ Agent นั้น ค่า `[]` หมายถึงไม่อนุมัติเครื่องมือใดเลย

## เสียงแจ้งเตือน

เลือก **Nod: Choose Alert Sound** แล้วเลือกไฟล์บนเครื่อง Nod จะบันทึก path และเล่นตัวอย่างทันที

| ระบบปฏิบัติการ | รูปแบบที่รองรับ | Player |
| --- | --- | --- |
| macOS | WAV, MP3, M4A, AIFF | `afplay` |
| Windows | WAV | PowerShell `SoundPlayer` |
| Linux | WAV | `paplay` หรือ `aplay` |

เสียงเล่นได้สูงสุด 5 วินาทีต่อครั้ง จึงเหมาะกับคลิปสั้น หากไฟล์ถูกย้าย ลบ หรือเปิดไม่ได้ Nod จะย้อนกลับไปใช้เสียง built-in และบันทึกเหตุผลใน **Show Log** ใช้ **Restore Built-in Sound** เมื่อต้องการล้างเสียงที่เลือก

## ความเป็นส่วนตัวและความปลอดภัย

```text
Codex / Claude Code
        │ native hook
        ▼
  Node.js helper
        │ authenticated localhost request
        ▼
   Nod in the IDE
        ├── Sound / Notification
        └── Optional allow decision
```

- Helper ส่งเฉพาะชื่อ Agent, ชนิดเหตุการณ์, ชื่อเครื่องมือ, session/request ID และ `cwd`
- ไม่ส่ง tool arguments, คำสั่ง shell, transcript หรือเนื้อหาบทสนทนาไปยัง IDE
- bridge รับเฉพาะ `127.0.0.1` และใช้ token แยกต่อหน้าต่าง
- ไฟล์ connection บน POSIX ใช้ permission `0600` และ directory ใช้ `0700`
- endpoint refresh ทุก 15 วินาที มีอายุไม่เกิน 5 นาที และไฟล์เก่าถูกเก็บกวาดอัตโนมัติ
- ไม่มี telemetry และไม่มีการส่งข้อมูลออกสู่อินเทอร์เน็ตโดย Nod
- ถ้า IDE ปิดอยู่ ไม่มี workspace ที่ตรงกัน หรือ Nod ไม่พร้อม Helper จะไม่ตัดสินใจและปล่อยให้ Agent ใช้ขั้นตอน permission ตามปกติ

สำหรับ Codex ใช้ [`PermissionRequest`](https://learn.chatgpt.com/docs/hooks#permissionrequest) และ [`PreToolUse`](https://learn.chatgpt.com/docs/hooks#pretooluse) สำหรับ Claude Code ใช้ [`PermissionRequest`](https://code.claude.com/docs/en/hooks#permissionrequest) และ [`PreToolUse`](https://code.claude.com/docs/en/hooks#pretooluse)

## การใช้งานหลาย IDE

ตั้งแต่รุ่น `0.5.0` เป็นต้นไป Nod ใช้ registry กลางที่ `~/.agent-alert` จึงเปิด VS Code, Antigravity หรือ IDE ที่รองรับ VSIX พร้อมกันได้ แต่ละ IDE ต้องติดตั้ง Nod รุ่น `0.5.0` ขึ้นไปและใช้ `agentAlert.sharedDataDirectory` เดียวกัน

- เหตุการณ์จะถูกส่งไปยังหน้าต่างที่มี workspace ตรงกับ `cwd` มากที่สุด
- ถ้าเปิดโปรเจกต์เดียวกันหลายหน้าต่าง คำถามอาจแสดง Notification มากกว่าหนึ่งหน้าต่าง
- สำหรับ permission request ระบบจะหยุดเมื่อหน้าต่างหนึ่งส่งผลอนุมัติได้
- รุ่น `0.6.0` เปลี่ยน display name เป็น **Nod** แต่คง extension ID และ settings `agentAlert.*` เพื่อรักษาค่าจากรุ่นก่อน

## ข้อจำกัด

- รองรับเฉพาะ workspace และ Agent ที่ทำงานบนเครื่องเดียวกับ IDE
- ยังไม่รองรับ SSH, Dev Containers, WSL หรือ Agent ที่อยู่คนละเครื่อง
- Claude Code บาง prompt เช่น network request ของ sandbox ไม่ส่ง `PermissionRequest` และ Nod ยังไม่ได้รับเหตุการณ์ `Notification` ประเภทนั้น
- Codex บางเส้นทางอาจไม่ส่ง `PreToolUse` สำหรับคำถาม ต้องทดสอบกับ Codex เวอร์ชันและโหมดที่ใช้งานจริง
- Claude ในเอกสารนี้หมายถึง **Claude Code** ไม่ใช่ claude.ai หรือแอป Claude ทั่วไป
- hooks ระดับผู้ใช้ของ Claude Code อาจรับเหตุการณ์จาก CLI ที่ใช้ configuration เดียวกัน เมื่อ `cwd` อยู่ใน workspace ที่ Nod เปิดอยู่
- IDE ที่รองรับ VSIX อาจมีพฤติกรรม UI ต่างจาก VS Code และยังไม่ได้ทดสอบครบทุกผลิตภัณฑ์

## แก้ปัญหาเบื้องต้น

| อาการ | วิธีตรวจสอบ |
| --- | --- |
| Status แสดง **Setup needed** | เปิด **Nod: Show Connection Status** และ **Nod: Show Log** |
| หา Node.js ไม่พบ | ติดตั้ง Node.js 18+ แล้วปิดและเปิด IDE ใหม่เพื่อให้รับ `PATH` ล่าสุด |
| Test Notification ทำงาน แต่เหตุการณ์จริงไม่มา | เริ่ม Agent session ใหม่ แล้วตรวจ hooks/trust ผ่าน `/hooks` |
| Codex ไม่โหลด hook | ตรวจว่า `[features] hooks = true` และ trust นิยาม hook แล้ว |
| Claude Code ไม่โหลด hook | ตรวจ `disableAllHooks`, configuration directory และเริ่ม session ใหม่ |
| ไม่มีเสียงบน Linux | ติดตั้ง `paplay` หรือ `aplay` และตรวจ audio output |
| เสียงที่เลือกเล่นไม่ได้ | ใช้ไฟล์ที่รองรับหรือเลือก **Restore Built-in Sound** |
| ใช้งานผ่าน SSH / Container / WSL | รุ่นนี้ยังไม่รองรับ remote workspace |

## พัฒนาและทดสอบ

```sh
npm ci
npm test
npm run package
```

กด **F5** เพื่อเปิด Extension Development Host ระหว่างพัฒนา ควรปิด `agentAlert.setup.automatic` หรือกำหนด `agentAlert.codexHome` และ `agentAlert.claudeHome` ไปยัง directory ทดสอบ เพื่อไม่ให้แก้ configuration ที่ใช้งานจริง

Automated tests ใช้ fixture และ localhost ไม่เล่นเสียงหรือแก้ Agent configuration จริง โดยครอบคลุม hook subprocess, authentication, routing หลาย IDE, workspace trust, timeout, configuration merge, Auto Approve cancellation และ sound player อย่างไรก็ตามควรทดสอบกับหน้าจอและ Agent เวอร์ชันจริงก่อน release

## ถอนการเชื่อมต่อ

1. ปิด `agentAlert.setup.automatic`
2. Pause หรือ Disable Nod
3. ลบเฉพาะ command hook ที่มี `--agent-alert-codex` ออกจาก Codex `hooks.json`
4. ลบเฉพาะ command hook ที่มี `--agent-alert-claude` ออกจาก Claude Code `settings.json`

อย่าลบ settings หรือ hooks ของเครื่องมืออื่น เมื่อ Nod ไม่ได้เปิดอยู่ Helper จะไม่ส่งผลอนุมัติ

## License

เผยแพร่ภายใต้ [MIT License](https://github.com/Pimmawat/Nod/blob/main/LICENSE)
