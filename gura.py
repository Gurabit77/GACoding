#!/usr/bin/env python3
"""
Gura - 自主 AI Agent 循环执行器（含 Validator）
已改造：dashboard 调用替换为 Gura REST API
"""

import json
import sys
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

# 配置
MAX_ITERATIONS = 50  # 默认值，main()中根据story数量自适应
TIMEOUT_SECONDS = 30 * 60
GURA_PORT = int(os.environ.get("GURA_PORT", 7334))
GURA_BASE = f"http://127.0.0.1:{GURA_PORT}"

# --- 读取桌面版配置（~/.gura/config.json + cli-registry.json）---
# 优先级：命令行参数 > ~/.gura/config.json:activeCli > 默认 claude
_HOME_GURA = Path.home() / ".gura"
_CONFIG_FILE = _HOME_GURA / "config.json"
_REGISTRY_FILE = _HOME_GURA / "cli-registry.json"

def _read_json(p, default):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

_CONFIG = _read_json(_CONFIG_FILE, {})
_REGISTRY = _read_json(_REGISTRY_FILE, [])

AGENT = sys.argv[1] if len(sys.argv) > 1 else _CONFIG.get("activeCli", "claude")

# 在自定义注册表中查找匹配的 CLI 配置（用于桌面版手动添加的 CLI）
_CUSTOM_CLI = next((c for c in _REGISTRY if c.get("id") == AGENT), None)

# --- Gura API 调用 ---

def gura_api(method, path, body=None):
    """调用 Gura REST API"""
    try:
        data = json.dumps(body).encode() if body else None
        req = Request(f"{GURA_BASE}{path}", data=data, method=method,
                      headers={"Content-Type": "application/json"} if data else {})
        with urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except (URLError, Exception) as e:
        print(f"  ⚠️  Gura API 调用失败: {e}")
        return None

def gura_set_state(iteration=None, phase=None, current_story=None):
    """更新 Gura 状态到 Gura 面板"""
    body = {}
    if iteration is not None: body["iteration"] = iteration
    if phase is not None: body["phase"] = phase
    if current_story is not None: body["currentStory"] = current_story
    gura_api("PUT", "/api/gura/state", body)

def gura_sync_prd():
    """从 prd.json 同步任务到 Pi"""
    gura_api("POST", "/api/gura/sync")

def gura_log(msg):
    """发送日志到 Pi + 结构化 stdout"""
    print(json.dumps({"type": "log", "msg": msg}, ensure_ascii=False), flush=True)
    gura_api("POST", "/api/log", {"msg": msg})

def update_stats(gold_add=0, exp_add=0, minutes_add=0, projects_add=0, iterations_add=0):
    """更新持久化统计数据"""
    cur = gura_api("GET", "/api/stats")
    if not cur or not isinstance(cur, dict):
        return  # GET失败时跳过，防止覆盖已有数据
    cur["gold"] = cur.get("gold", 0) + gold_add
    cur["exp"] = cur.get("exp", 0) + exp_add
    cur["totalMinutes"] = cur.get("totalMinutes", 0) + minutes_add
    cur["projectsCompleted"] = cur.get("projectsCompleted", 0) + projects_add
    cur["totalIterations"] = cur.get("totalIterations", 0) + iterations_add
    gura_api("PUT", "/api/stats", cur)


def build_cmd(prompt: str) -> list[str]:
    """支持 claude / codex / kiro 三种内置 agent，以及桌面版注册的自定义 CLI"""
    # 自定义 CLI：使用 cli-registry.json 里的 path + chatTemplate
    if _CUSTOM_CLI:
        bin_path = _CUSTOM_CLI.get("path") or _CUSTOM_CLI.get("bin") or AGENT
        tpl = _CUSTOM_CLI.get("chatTemplate") or ["{prompt}"]
        return [bin_path] + [t.replace("{prompt}", prompt) for t in tpl]
    if AGENT == "codex":
        return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", prompt]
    if AGENT == "kiro":
        return ["kiro-cli", "chat", "--no-interactive", "-a", prompt]
    return ["claude", "--print", "--dangerously-skip-permissions", prompt]


def build_process_cmd(prompt: str) -> list[str]:
    import platform
    base = build_cmd(prompt)
    if platform.system() == "Darwin":
        return ["script", "-q", "/dev/null"] + base
    elif platform.system() == "Linux":
        return ["script", "-qc", " ".join(base), "/dev/null"]
    return base  # Windows / 其他：不包装


SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = Path.cwd()  # 用户项目根目录
CLAUDE_INSTRUCTION_FILE = SCRIPT_DIR / "BUILDER.md"
VALIDATOR_INSTRUCTION_FILE = SCRIPT_DIR / "VALIDATOR.md"
PRD_FILE = PROJECT_ROOT / "scripts" / "gura" / "prd.json"


def _kill_process(process):
    """安全终止子进程（含整个进程组）"""
    import signal as _sig
    try:
        os.killpg(os.getpgid(process.pid), _sig.SIGTERM)
        process.wait(timeout=5)
    except (subprocess.TimeoutExpired, ProcessLookupError, PermissionError):
        try:
            os.killpg(os.getpgid(process.pid), _sig.SIGKILL)
            process.wait(timeout=3)
        except Exception:
            pass
    except OSError:
        pass


def _poll_with_signals(process, timeout, label="Agent"):
    """轮询子进程，同时响应 pause/skip 信号。返回 'done'/'crashed'/'timeout'/'paused'/'skipped'"""
    start_time = time.time()
    while True:
        try:
            code = process.wait(timeout=5)
            # 非 0 退出 = CLI 异常（未登录、API 失败、崩溃），必须区分出来
            # 否则循环会把失败当"开发完成"，无限跑直到 maxIterations
            if code != 0:
                print(f"\n⚠️  {label} 非 0 退出 (code={code})")
                return "crashed"
            return "done"
        except subprocess.TimeoutExpired:
            pass
        if time.time() - start_time > timeout:
            print(f"\n⚠️  {label} 超时!")
            _kill_process(process)
            return "timeout"
        sig = check_signals()
        if sig == "pause":
            _kill_process(process)
            return "paused"
        if sig == "skip":
            _kill_process(process)
            return "skipped"


def run_developer(iteration: int) -> str:
    """返回 'done'/'timeout'/'paused'/'skipped'"""
    print(f"\n{'='*64}\n  迭代 {iteration}/{MAX_ITERATIONS}\n{'='*64}")
    if not CLAUDE_INSTRUCTION_FILE.exists():
        print(f"❌ 错误: {CLAUDE_INSTRUCTION_FILE} 不存在")
        return "done"

    prompt = CLAUDE_INSTRUCTION_FILE.read_text()
    cmd = build_process_cmd(prompt)

    try:
        process = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), start_new_session=True)
        return _poll_with_signals(process, TIMEOUT_SECONDS, "开发 Agent")
    except Exception as e:
        print(f"\n❌ 开发 Agent 错误: {e}")
        return "done"


def run_validator(iteration: int) -> str:
    """返回 'done'/'timeout'/'paused'/'skipped'"""
    print(f"\n{'='*64}\n  验证迭代 {iteration}\n{'='*64}")
    if not VALIDATOR_INSTRUCTION_FILE.exists():
        print(f"⚠️  {VALIDATOR_INSTRUCTION_FILE} 不存在，跳过验证")
        return "done"

    prompt = VALIDATOR_INSTRUCTION_FILE.read_text()
    cmd = build_process_cmd(prompt)

    try:
        process = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), start_new_session=True)
        return _poll_with_signals(process, TIMEOUT_SECONDS * 2, "Validator")
    except Exception as e:
        print(f"\n❌ Validator 错误: {e}")
        return "done"


def run_final_validation() -> str:
    """全部 story 完成后的整体验证。返回 'done'/'timeout'/'paused'/'skipped'"""
    print(f"\n{'='*64}\n  最终整体验证\n{'='*64}")
    final_md = SCRIPT_DIR / "FINAL_VALIDATOR.md"
    if not final_md.exists():
        print("⚠️  FINAL_VALIDATOR.md 不存在，跳过整体验证")
        return "done"
    prompt = final_md.read_text()
    cmd = build_process_cmd(prompt)
    try:
        process = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), start_new_session=True)
        return _poll_with_signals(process, TIMEOUT_SECONDS * 2, "整体验证")
    except Exception as e:
        print(f"\n❌ 整体验证错误: {e}")
        return "done"


def get_story_retry_count(story_id: str) -> int:
    """读取指定 story 的 retryCount"""
    try:
        prd = json.loads(PRD_FILE.read_text())
        for s in prd.get("userStories", []):
            if s.get("id") == story_id:
                return s.get("retryCount", 0)
    except Exception:
        pass
    return 0


def get_current_story_id() -> str:
    try:
        prd = json.loads(PRD_FILE.read_text())
        for story in prd.get("userStories", []):
            if not story.get("passes", False) and not story.get("blocked", False):
                return story.get("id")
    except Exception:
        pass
    return None


def check_precheck():
    """启动前环境预检"""
    errors = []
    # 检查 prd.json 存在
    if not PRD_FILE.exists():
        errors.append(f"prd.json 不存在: {PRD_FILE}")
    else:
        try:
            prd = json.loads(PRD_FILE.read_text())
            stories = prd.get("userStories", [])
            if not stories:
                errors.append("prd.json 中没有 userStories")
        except Exception as e:
            errors.append(f"prd.json 解析失败: {e}")

    # 检查 Agent CLI 可用
    agent_cmds = {"claude": "claude", "kiro": "kiro-cli", "codex": "codex"}
    cmd = agent_cmds.get(AGENT, AGENT)
    import shutil
    if not shutil.which(cmd):
        errors.append(f"Agent CLI 不可用: {cmd} (agent={AGENT})")

    # 检查 server 可达
    try:
        req = Request(f"{GURA_BASE}/api/status", method="GET")
        with urlopen(req, timeout=3) as resp:
            resp.read()
    except Exception:
        errors.append(f"Gura server 不可达: {GURA_BASE} (先启动 server)")

    # 检查 git。不是 git 仓库就自动 git init（避免用户手工操作）
    try:
        subprocess.run(["git", "status"], capture_output=True, check=True, cwd=str(PROJECT_ROOT))
    except (subprocess.CalledProcessError, FileNotFoundError):
        try:
            # 先看 git 命令本身在不在
            subprocess.run(["git", "--version"], capture_output=True, check=True)
            # 自动初始化：init + 初始 commit（gura 某些 agent 依赖 HEAD 存在）
            subprocess.run(["git", "init", "-q"], check=True, cwd=str(PROJECT_ROOT))
            # 允许空 commit 以确保 HEAD 存在；用 -c 指定默认身份避免全局 git config 未设的情况
            env = os.environ.copy()
            env.setdefault("GIT_AUTHOR_NAME", "gura")
            env.setdefault("GIT_AUTHOR_EMAIL", "gura@local")
            env.setdefault("GIT_COMMITTER_NAME", "gura")
            env.setdefault("GIT_COMMITTER_EMAIL", "gura@local")
            # 尝试加 .gitignore + README 再 commit，没内容就空 commit
            subprocess.run(["git", "add", "-A"], capture_output=True, cwd=str(PROJECT_ROOT), env=env)
            commit = subprocess.run(
                ["git", "commit", "--allow-empty", "-q", "-m", "gura: auto init"],
                capture_output=True, cwd=str(PROJECT_ROOT), env=env
            )
            if commit.returncode != 0:
                errors.append(f"自动 git init 成功但首次 commit 失败: {commit.stderr.decode(errors='ignore').strip()[:200]}")
            else:
                print(f"✅ 已自动为项目初始化 git: {PROJECT_ROOT}")
        except (subprocess.CalledProcessError, FileNotFoundError) as ge:
            errors.append(f"项目目录不是 git 仓库且自动初始化失败: {ge}")

    # 检查 Agent 登录 / API 额度：拿一个超短 prompt 试探。
    # 没登录的 claude 会 exit=1，codex 也类似。这样能在进入循环前就暴露问题，
    # 不至于静默跑 50 轮空转（此前 claude 一直回 "Not logged in" 循环就是这个 bug）。
    try:
        test_cmd = build_cmd("ping")
        r = subprocess.run(test_cmd, capture_output=True, text=True, timeout=25,
                           cwd=str(PROJECT_ROOT))
        out = (r.stdout or "") + (r.stderr or "")
        low = out.lower()
        bad_markers = ["not logged in", "please run /login", "unauthorized", "authentication",
                       "api key", "please sign in", "login required", "rate limit",
                       "quota exceeded", "insufficient credit"]
        hit = next((m for m in bad_markers if m in low), None)
        if r.returncode != 0 or hit:
            excerpt = out.strip().splitlines()
            excerpt = " / ".join(excerpt[-3:])[:240] if excerpt else f"exit={r.returncode}"
            if hit:
                errors.append(f"Agent CLI 登录/授权异常 ({AGENT}): {excerpt}")
            else:
                errors.append(f"Agent CLI 异常退出 ({AGENT}, exit={r.returncode}): {excerpt}")
    except subprocess.TimeoutExpired:
        # 登录时要人工交互时会卡死。25 秒是宽松上限。
        errors.append(f"Agent CLI 探测超时（25s）— {AGENT} 可能在等 OAuth 或网络")
    except FileNotFoundError:
        pass  # 前面 which 已经报了，这里不重复
    except Exception as e:
        errors.append(f"Agent CLI 探测失败 ({AGENT}): {e}")

    return errors


def check_signals():
    """检查暂停/跳过信号文件，返回 'pause'/'skip'/None"""
    sig_dir = PROJECT_ROOT / ".pi"
    pause_file = sig_dir / "gura.pause"
    skip_file = sig_dir / "gura.skip"
    if pause_file.exists():
        return "pause"
    if skip_file.exists():
        skip_file.unlink(missing_ok=True)
        return "skip"
    return None


def _atomic_write(path, content):
    """原子写入：先写tmp再rename，防止写入中断导致文件损坏"""
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(content)
    tmp.rename(path)


def _do_skip(story_id):
    """将指定 story 标记为 blocked/skipped"""
    if not story_id:
        return
    gura_log(f"⏭ 跳过 {story_id}")
    try:
        prd = json.loads(PRD_FILE.read_text())
        for s in prd.get("userStories", []):
            if s.get("id") == story_id:
                s["blocked"] = True
                s["notes"] = "[SKIPPED] 用户手动跳过"
        _atomic_write(PRD_FILE, json.dumps(prd, indent=2, ensure_ascii=False))
    except Exception:
        pass
    gura_sync_prd()


def all_stories_resolved() -> bool:
    try:
        prd = json.loads(PRD_FILE.read_text())
        for story in prd.get("userStories", []):
            if not story.get("passes", False) and not story.get("blocked", False):
                return False
        return True
    except Exception:
        return False


def format_duration(seconds: float) -> str:
    h, m, s = int(seconds // 3600), int((seconds % 3600) // 60), int(seconds % 60)
    return f"{h}h{m}m{s}s" if h else f"{m}m{s}s" if m else f"{s}s"


def main():
    global MAX_ITERATIONS
    # 防止多进程冲突：PID 文件锁
    pid_file = PROJECT_ROOT / ".pi" / "gura.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    # 用 fcntl.flock 做原子锁（仅 Unix）
    lock_file = PROJECT_ROOT / ".pi" / "gura.lock"
    lock_fd = None
    try:
        import fcntl
        lock_fd = open(lock_file, 'w')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        # 锁获取失败 = 另一个实例在跑
        print("⚠️  另一个 Gura 实例正在运行，退出")
        sys.exit(0)
    except ImportError:
        pass  # Windows 无 fcntl，回退到 PID 检查
    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text().strip())
            result = subprocess.run(["ps", "-p", str(old_pid), "-o", "command="], capture_output=True, text=True)
            if "gura" in result.stdout:
                import signal
                os.kill(old_pid, signal.SIGTERM)
                print(f"⚠️  杀掉旧进程 {old_pid}")
                import time as _t; _t.sleep(1)
        except (ValueError, ProcessLookupError, PermissionError, OSError):
            pass
    pid_file.write_text(str(os.getpid()))

    print(f"启动 Gura - 最大迭代次数: {MAX_ITERATIONS}")
    total_start_time = time.time()

    # 启动前环境预检
    precheck_errors = check_precheck()
    if precheck_errors:
        print("❌ 环境预检失败:")
        for e in precheck_errors:
            print(f"  - {e}")
        pid_file.unlink(missing_ok=True)
        sys.exit(1)
    print("✅ 环境预检通过")

    # 断点续跑检测 + 自适应 maxIterations
    start_iteration = 0
    try:
        prd = json.loads(PRD_FILE.read_text())
        stories = prd.get("userStories", [])
        done_stories = [s for s in stories if s.get("passes")]
        remaining = [s for s in stories if not s.get("passes") and not s.get("blocked")]
        if done_stories:
            state = gura_api("GET", "/api/gura/state")
            if state and state.get("gura", {}).get("iteration", 0) > 0:
                start_iteration = state["gura"]["iteration"]
            next_id = remaining[0]["id"] if remaining else "(全部完成)"
            msg = f"🔄 断点续跑：已完成 {len(done_stories)} 个 story，从 {next_id} 继续 (iteration={start_iteration})"
            print(msg)
            gura_log(msg)
        MAX_ITERATIONS = max(50, len(stories) * 2)
    except Exception:
        MAX_ITERATIONS = 50

    # 初始化 Gura 面板状态
    gura_set_state(iteration=start_iteration, phase="idle", current_story="")
    gura_api("PUT", "/api/gura/state", {"maxIterations": MAX_ITERATIONS, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S")})
    gura_sync_prd()
    if not start_iteration:
        gura_log("Gura 启动")

    # 只重跑验证模式：连续验证失败计数（per story）
    validate_only_count = {}  # story_id -> 连续跳过开发直接验证的次数
    # 连续 CLI 异常退出计数。超过阈值就 abort 避免无限跑
    consecutive_crashes = 0
    MAX_CONSECUTIVE_CRASHES = 3

    for i in range(start_iteration + 1, MAX_ITERATIONS + 1):
        try:
            # 如果所有story已完成，直接进入最终验证
            if all_stories_resolved():
                gura_set_state(phase="final_validation", current_story="")
                gura_log("🔍 全部 story 完成，启动最终整体验证...")
                result = run_final_validation()
                if result == "paused":
                    gura_set_state(phase="paused")
                    gura_log("⏸ 整体验证中暂停，等待恢复...")
                    while check_signals() == "pause":
                        time.sleep(2)
                    gura_log("▶ 恢复执行，重新整体验证")
                    continue
                gura_sync_prd()
                gura_set_state(phase="done")
                elapsed = format_duration(time.time() - total_start_time)
                elapsed_min = int((time.time() - total_start_time) / 60)
                update_stats(gold_add=1, projects_add=1, minutes_add=elapsed_min)
                gura_log(f"✅ 全部完成! 耗时 {elapsed}")
                pid_file.unlink(missing_ok=True)
                sys.exit(0)

            # 检查暂停/跳过信号
            sig = check_signals()
            if sig == "pause":
                gura_set_state(phase="paused")
                gura_log("⏸ 用户暂停，等待恢复...")
                print("⏸ 已暂停，删除 .pi/gura.pause 文件恢复")
                while check_signals() == "pause":
                    time.sleep(2)
                gura_log("▶ 恢复执行")
                gura_set_state(phase="idle")
            elif sig == "skip":
                current_story = get_current_story_id()
                _do_skip(current_story)
                continue

            current_story = get_current_story_id()
            story_start = time.time()
            story_start_iso = datetime.now(timezone.utc).isoformat()

            # 只重跑验证模式：retryCount>0 且连续验证失败<3次时跳过开发
            skip_dev = False
            if current_story and get_story_retry_count(current_story) > 0:
                vo = validate_only_count.get(current_story, 0)
                if vo < 3:
                    skip_dev = True
                else:
                    validate_only_count[current_story] = 0

            if skip_dev:
                gura_set_state(iteration=i, phase="validating", current_story=current_story)
                gura_sync_prd()
                vo = validate_only_count.get(current_story, 0) + 1
                gura_log(f"迭代 {i}: 跳过开发，直接重跑验证 {current_story} ({vo}/3)")
                validate_only_count[current_story] = vo
            else:
                gura_set_state(iteration=i, phase="developing", current_story=current_story)
                gura_sync_prd()
                gura_log(f"迭代 {i}: 开发 {current_story or '?'}")

                # 保护 prd.json 防止 Agent 的 git 操作覆盖
                prd_backup = PRD_FILE.read_text() if PRD_FILE.exists() else None
                result = run_developer(i)
                if prd_backup and PRD_FILE.exists():
                    try:
                        cur = json.loads(PRD_FILE.read_text())
                        bak = json.loads(prd_backup)
                        cur_ids = set(s.get("id") for s in cur.get("userStories", []))
                        bak_ids = set(s.get("id") for s in bak.get("userStories", []))
                        if cur_ids != bak_ids:
                            # story列表被覆盖了，恢复备份但合并passes/notes
                            cur_map = {s.get("id"): s for s in cur.get("userStories", [])}
                            for s in bak.get("userStories", []):
                                if s["id"] in cur_map:
                                    c = cur_map[s["id"]]
                                    if c.get("passes"): s["passes"] = True
                                    if c.get("notes"): s["notes"] = c["notes"]
                            _atomic_write(PRD_FILE, json.dumps(bak, indent=2, ensure_ascii=False))
                    except Exception:
                        pass

                if result == "paused":
                    gura_set_state(phase="paused")
                    gura_log("⏸ 开发中暂停，等待恢复...")
                    while check_signals() == "pause":
                        time.sleep(2)
                    gura_log("▶ 恢复执行")
                    gura_set_state(phase="idle")
                    continue
                if result == "skipped":
                    _do_skip(current_story)
                    continue
                if result == "timeout":
                    gura_set_state(phase="idle")
                    gura_log(f"迭代 {i}: 开发超时，跳过验证")
                    time.sleep(2)
                    continue
                if result == "crashed":
                    consecutive_crashes += 1
                    gura_log(f"❌ 迭代 {i}: 开发 Agent CLI 异常退出 ({consecutive_crashes}/{MAX_CONSECUTIVE_CRASHES}) — 检查 CLI 登录状态 / API 额度 / 网络")
                    if consecutive_crashes >= MAX_CONSECUTIVE_CRASHES:
                        gura_log(f"❌ 连续 {MAX_CONSECUTIVE_CRASHES} 轮 CLI 崩溃，终止执行避免空转")
                        gura_set_state(phase="idle")
                        pid_file.unlink(missing_ok=True)
                        sys.exit(2)
                    time.sleep(2)
                    continue
                # 开发成功：清零连续崩溃计数
                consecutive_crashes = 0

            if not skip_dev:
                gura_set_state(phase="validating")
                gura_sync_prd()
                gura_log(f"迭代 {i}: 验证 {current_story or '?'}")
            prd_backup = PRD_FILE.read_text() if PRD_FILE.exists() else None
            result = run_validator(i)
            if prd_backup and PRD_FILE.exists():
                try:
                    cur = json.loads(PRD_FILE.read_text())
                    bak = json.loads(prd_backup)
                    cur_ids = set(s.get("id") for s in cur.get("userStories", []))
                    bak_ids = set(s.get("id") for s in bak.get("userStories", []))
                    if cur_ids != bak_ids:
                        cur_map = {s.get("id"): s for s in cur.get("userStories", [])}
                        for s in bak.get("userStories", []):
                            if s["id"] in cur_map:
                                c = cur_map[s["id"]]
                                if c.get("passes"): s["passes"] = True
                                if c.get("notes"): s["notes"] = c["notes"]
                        _atomic_write(PRD_FILE, json.dumps(bak, indent=2, ensure_ascii=False))
                except Exception:
                    pass

            if result == "paused":
                gura_set_state(phase="paused")
                gura_log("⏸ 验证中暂停，等待恢复...")
                while check_signals() == "pause":
                    time.sleep(2)
                gura_log("▶ 恢复执行")
                gura_set_state(phase="idle")
                continue
            if result == "skipped":
                _do_skip(current_story)
                continue
            if result == "crashed":
                consecutive_crashes += 1
                gura_log(f"❌ 迭代 {i}: 验证 Agent CLI 异常退出 ({consecutive_crashes}/{MAX_CONSECUTIVE_CRASHES}) — 检查 CLI 登录状态 / API 额度 / 网络")
                if consecutive_crashes >= MAX_CONSECUTIVE_CRASHES:
                    gura_log(f"❌ 连续 {MAX_CONSECUTIVE_CRASHES} 轮 CLI 崩溃，终止执行避免空转")
                    gura_set_state(phase="idle")
                    pid_file.unlink(missing_ok=True)
                    sys.exit(2)
                time.sleep(2)
                continue

            gura_set_state(phase="idle")
            gura_sync_prd()
            update_stats(gold_add=1, exp_add=100, iterations_add=1)

            # 验证通过时清除该 story 的验证重试计数
            if current_story:
                try:
                    prd = json.loads(PRD_FILE.read_text())
                    story = next((s for s in prd.get("userStories", []) if s.get("id") == current_story), None)
                    if story and story.get("passes"):
                        validate_only_count.pop(current_story, None)
                except Exception:
                    pass

            # 更新 story 耗时
            if current_story:
                gura_api("PUT", "/api/task", {
                    "id": current_story,
                    "startedAt": story_start_iso,
                    "finishedAt": datetime.now(timezone.utc).isoformat()
                })

            if all_stories_resolved():
                gura_set_state(phase="final_validation", current_story="")
                gura_log("🔍 全部 story 完成，启动最终整体验证...")
                result = run_final_validation()
                if result == "paused":
                    gura_set_state(phase="paused")
                    gura_log("⏸ 整体验证中暂停，等待恢复...")
                    while check_signals() == "pause":
                        time.sleep(2)
                    gura_log("▶ 恢复执行，重新整体验证")
                    continue
                gura_sync_prd()

                gura_set_state(phase="done")
                elapsed = format_duration(time.time() - total_start_time)
                elapsed_min = int((time.time() - total_start_time) / 60)
                update_stats(gold_add=1, projects_add=1, minutes_add=elapsed_min)
                gura_log(f"✅ 全部完成! 耗时 {elapsed}")
                print(f"✅ 所有任务已完成! 耗时 {elapsed}")
                pid_file.unlink(missing_ok=True)
                sys.exit(0)

        except KeyboardInterrupt:
            gura_set_state(phase="idle")
            elapsed_min = int((time.time() - total_start_time) / 60)
            update_stats(minutes_add=elapsed_min)
            gura_log(f"⚠️ 用户中断 (耗时 {format_duration(time.time() - total_start_time)})")
            pid_file.unlink(missing_ok=True)
            sys.exit(130)

    elapsed_min = int((time.time() - total_start_time) / 60)
    update_stats(minutes_add=elapsed_min)
    gura_log(f"已达最大迭代 ({MAX_ITERATIONS})")
    pid_file.unlink(missing_ok=True)
    sys.exit(1)


if __name__ == "__main__":
    main()
