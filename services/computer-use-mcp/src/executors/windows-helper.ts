import type { ComputerUseConfig } from '../types'

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env, platform } from 'node:process'

import { runProcess } from '../utils/process'

// This is intentionally a small, single-purpose native companion rather than a
// PowerShell automation script. It keeps desktop input local and gives the MCP
// layer one JSON contract for observation, UI Automation, screenshots, and input.
const helperSource = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows;
using System.Windows.Forms;

public static class Program {
  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_HWHEEL = 0x01000;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const int SW_RESTORE = 9;
  const int MAX_AUTOMATION_NODES = 800;
  const uint DESKTOP_READOBJECTS = 0x0001;
  const uint DESKTOP_ENUMERATE = 0x0040;
  const uint DESKTOP_SWITCHDESKTOP = 0x0100;

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION U; }
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
  static IDictionary<string, object> Input;

  static void AttachInputDesktop() {
    var desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS | DESKTOP_ENUMERATE | DESKTOP_SWITCHDESKTOP);
    if (desktop != IntPtr.Zero) SetThreadDesktop(desktop);
  }

  static IDictionary<string, object> ReadInput() {
    var raw = Console.In.ReadToEnd();
    if (String.IsNullOrWhiteSpace(raw)) return new Dictionary<string, object>();
    return Json.Deserialize<Dictionary<string, object>>(raw);
  }
  static string Text(string key, string fallback = "") { return Input.ContainsKey(key) && Input[key] != null ? Convert.ToString(Input[key]) : fallback; }
  static int Number(string key, int fallback = 0) { try { return Input.ContainsKey(key) ? Convert.ToInt32(Input[key]) : fallback; } catch { return fallback; } }
  static bool Flag(string key, bool fallback = false) { try { return Input.ContainsKey(key) ? Convert.ToBoolean(Input[key]) : fallback; } catch { return fallback; } }
  static IDictionary<string, object> Bounds(RECT r) { return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "width", Math.Max(0, r.Right - r.Left) }, { "height", Math.Max(0, r.Bottom - r.Top) } }; }
  static IDictionary<string, object> Bounds(Rect r) { return new Dictionary<string, object> { { "x", (int)Math.Round(r.Left) }, { "y", (int)Math.Round(r.Top) }, { "width", Math.Max(0, (int)Math.Round(r.Width)) }, { "height", Math.Max(0, (int)Math.Round(r.Height)) } }; }
  static string WindowTitle(IntPtr hWnd) { var size = GetWindowTextLength(hWnd); var text = new System.Text.StringBuilder(Math.Max(size + 1, 256)); GetWindowText(hWnd, text, text.Capacity); return text.ToString().Trim(); }
  static string AppName(IntPtr hWnd, out int pid) {
    uint rawPid; GetWindowThreadProcessId(hWnd, out rawPid); pid = (int)rawPid;
    try { return Process.GetProcessById(pid).ProcessName; } catch { return "unknown"; }
  }
  static IDictionary<string, object> DescribeWindow(IntPtr hWnd) {
    int pid; var app = AppName(hWnd, out pid); RECT rect; GetWindowRect(hWnd, out rect);
    return new Dictionary<string, object> { { "id", hWnd.ToInt64().ToString() }, { "appName", app }, { "title", WindowTitle(hWnd) }, { "bounds", Bounds(rect) }, { "ownerPid", pid }, { "layer", 0 }, { "isOnScreen", true } };
  }
  static object ObserveWindows() {
    var windows = new List<object>(); var limit = Number("limit", 12); var appFilter = Text("app").ToLowerInvariant();
    EnumWindows(delegate(IntPtr hWnd, IntPtr _) {
      if (!IsWindowVisible(hWnd) || windows.Count >= limit) return true;
      var title = WindowTitle(hWnd); int pid; var app = AppName(hWnd, out pid);
      if (String.IsNullOrEmpty(title) || (!String.IsNullOrEmpty(appFilter) && app.ToLowerInvariant().IndexOf(appFilter) < 0)) return true;
      windows.Add(DescribeWindow(hWnd)); return true;
    }, IntPtr.Zero);
    var foreground = GetForegroundWindow(); var foregroundTitle = foreground == IntPtr.Zero ? "" : WindowTitle(foreground); int foregroundPid; var foregroundApp = foreground == IntPtr.Zero ? "" : AppName(foreground, out foregroundPid);
    return new Dictionary<string, object> { { "frontmostAppName", foregroundApp }, { "frontmostWindowTitle", foregroundTitle }, { "windows", windows }, { "observedAt", DateTime.UtcNow.ToString("o") } };
  }
  static object ListProcesses() {
    var processes = new List<object>(); var limit = Math.Max(1, Number("limit", 32)); var appFilter = Text("app").Trim().ToLowerInvariant();
    foreach (var process in Process.GetProcesses()) {
      try {
        var app = process.ProcessName ?? ""; var title = process.MainWindowTitle ?? "";
        if (!String.IsNullOrEmpty(appFilter) && app.ToLowerInvariant().IndexOf(appFilter) < 0 && title.ToLowerInvariant().IndexOf(appFilter) < 0) continue;
        processes.Add(new Dictionary<string, object> { { "pid", process.Id }, { "appName", app }, { "windowTitle", title }, { "hasMainWindow", process.MainWindowHandle != IntPtr.Zero }, { "responding", process.Responding } });
        if (processes.Count >= limit) break;
      } catch { } finally { process.Dispose(); }
    }
    return new Dictionary<string, object> { { "processes", processes }, { "observedAt", DateTime.UtcNow.ToString("o") } };
  }
  static object Foreground() { var hWnd = GetForegroundWindow(); if (hWnd == IntPtr.Zero) return new Dictionary<string, object> { { "available", false } }; int pid; var app = AppName(hWnd, out pid); RECT rect; GetWindowRect(hWnd, out rect); return new Dictionary<string, object> { { "available", true }, { "appName", app }, { "windowTitle", WindowTitle(hWnd) }, { "windowBounds", Bounds(rect) } }; }
  static object DisplayInfo() { var displays = new List<object>(); Rectangle union = Rectangle.Empty; foreach (var screen in Screen.AllScreens) { var r = screen.Bounds; union = union.IsEmpty ? r : Rectangle.Union(union, r); displays.Add(new Dictionary<string, object> { { "displayId", screen.DeviceName.GetHashCode() }, { "isMain", screen.Primary }, { "isBuiltIn", screen.Primary }, { "bounds", new Dictionary<string, object> { { "x", r.X }, { "y", r.Y }, { "width", r.Width }, { "height", r.Height } } }, { "visibleBounds", new Dictionary<string, object> { { "x", screen.WorkingArea.X }, { "y", screen.WorkingArea.Y }, { "width", screen.WorkingArea.Width }, { "height", screen.WorkingArea.Height } } }, { "scaleFactor", 1 }, { "pixelWidth", r.Width }, { "pixelHeight", r.Height } }); }
    return new Dictionary<string, object> { { "available", displays.Count > 0 }, { "logicalWidth", union.Width }, { "logicalHeight", union.Height }, { "pixelWidth", union.Width }, { "pixelHeight", union.Height }, { "scaleFactor", 1 }, { "isRetina", false }, { "displayCount", displays.Count }, { "displays", displays }, { "combinedBounds", new Dictionary<string, object> { { "x", union.X }, { "y", union.Y }, { "width", union.Width }, { "height", union.Height } } } };
  }
  static object Screenshot() { var output = Text("outputPath"); if (String.IsNullOrEmpty(output)) throw new InvalidOperationException("outputPath is required"); var r = SystemInformation.VirtualScreen; using (var bitmap = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb)) using (var graphics = Graphics.FromImage(bitmap)) { graphics.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size, CopyPixelOperation.SourceCopy); bitmap.Save(output, ImageFormat.Png); } return new Dictionary<string, object> { { "path", output }, { "width", r.Width }, { "height", r.Height } }; }
  static bool WindowMatchesApp(IntPtr hWnd, string app) { var needle = (app ?? "").Trim().ToLowerInvariant(); if (String.IsNullOrEmpty(needle)) return true; int pid; var process = AppName(hWnd, out pid).ToLowerInvariant(); var title = WindowTitle(hWnd).ToLowerInvariant(); return process.IndexOf(needle) >= 0 || title.IndexOf(needle) >= 0; }
  static IntPtr FindAppWindow(string app) { IntPtr visible = IntPtr.Zero; IntPtr hidden = IntPtr.Zero; EnumWindows(delegate(IntPtr hWnd, IntPtr _) { if (!WindowMatchesApp(hWnd, app)) return true; if (IsWindowVisible(hWnd)) { visible = hWnd; return false; } if (hidden == IntPtr.Zero && !String.IsNullOrEmpty(WindowTitle(hWnd))) hidden = hWnd; return true; }, IntPtr.Zero); if (visible != IntPtr.Zero) return visible; if (hidden != IntPtr.Zero) return hidden; var needle = (app ?? "").Trim().ToLowerInvariant(); foreach (var process in Process.GetProcesses()) { try { if (process.ProcessName.ToLowerInvariant().IndexOf(needle) >= 0 && process.MainWindowHandle != IntPtr.Zero) return process.MainWindowHandle; } catch { } finally { process.Dispose(); } } return IntPtr.Zero; }
  static object OpenApp() { var app = Text("app"); if (String.IsNullOrEmpty(app)) throw new InvalidOperationException("app is required"); Process.Start(new ProcessStartInfo { FileName = app, UseShellExecute = true }); return new Dictionary<string, object> { { "opened", app } }; }
  static IDictionary<string, object> FocusWindow(string app) { var hWnd = FindAppWindow(app); if (hWnd == IntPtr.Zero) throw new InvalidOperationException("no visible window matched " + app); ShowWindow(hWnd, SW_RESTORE); SetForegroundWindow(hWnd); Thread.Sleep(90); var foreground = GetForegroundWindow(); if (foreground == IntPtr.Zero || !WindowMatchesApp(foreground, app)) { var actual = foreground == IntPtr.Zero ? "none" : WindowTitle(foreground); throw new InvalidOperationException("focus verification failed for " + app + "; foreground window is " + actual); } return DescribeWindow(foreground); }
  static IDictionary<string, object> RequireForeground(string targetApp) { if (!String.IsNullOrWhiteSpace(targetApp)) FocusWindow(targetApp); var foreground = GetForegroundWindow(); if (foreground == IntPtr.Zero) throw new InvalidOperationException("no foreground window is available for input"); if (!String.IsNullOrWhiteSpace(targetApp) && !WindowMatchesApp(foreground, targetApp)) throw new InvalidOperationException("foreground verification failed for " + targetApp); return DescribeWindow(foreground); }
  static object FocusApp() { var app = Text("app"); if (String.IsNullOrWhiteSpace(app)) throw new InvalidOperationException("app is required"); return new Dictionary<string, object> { { "focused", app }, { "foreground", FocusWindow(app) } }; }
  static INPUT Mouse(uint flags, int x, int y, uint data = 0) { var screen = SystemInformation.VirtualScreen; var normalX = (int)Math.Round((x - screen.Left) * 65535.0 / Math.Max(1, screen.Width - 1)); var normalY = (int)Math.Round((y - screen.Top) * 65535.0 / Math.Max(1, screen.Height - 1)); return new INPUT { type = INPUT_MOUSE, U = new INPUTUNION { mi = new MOUSEINPUT { dx = normalX, dy = normalY, mouseData = data, dwFlags = flags | MOUSEEVENTF_ABSOLUTE, time = 0, dwExtraInfo = UIntPtr.Zero } } }; }
  static void Send(params INPUT[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new InvalidOperationException("SendInput failed"); }
  static void ApplyPointerTrace() { var trace = Input.ContainsKey("pointerTrace") ? Input["pointerTrace"] as ArrayList : null; if (trace == null) { SetCursorPos(Number("x"), Number("y")); return; } foreach (var entry in trace) { var p = entry as Dictionary<string, object>; if (p == null) continue; var x = p.ContainsKey("x") ? Convert.ToInt32(p["x"]) : 0; var y = p.ContainsKey("y") ? Convert.ToInt32(p["y"]) : 0; SetCursorPos(x, y); if (p.ContainsKey("delayMs")) Thread.Sleep(Math.Max(0, Convert.ToInt32(p["delayMs"]))); } }
  static object Click() { ApplyPointerTrace(); var x = Number("x"); var y = Number("y"); var button = Text("button", "left").ToLowerInvariant(); uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN; uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP; var count = Math.Max(1, Number("clickCount", 1)); for (var i = 0; i < count; i++) Send(Mouse(MOUSEEVENTF_MOVE, x, y), Mouse(down, x, y), Mouse(up, x, y)); return new Dictionary<string, object> { { "clicked", true } }; }
  static void SendUnicode(char c, bool up) { Send(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time = 0, dwExtraInfo = UIntPtr.Zero } } }); }
  static bool RequiresUnicodePaste(string text) { foreach (var c in text) { if (c > 0x7F) return true; } return false; }
  static void PasteUnicodeText(string text) { var hadText = Clipboard.ContainsText(TextDataFormat.UnicodeText); var previous = hadText ? Clipboard.GetText(TextDataFormat.UnicodeText) : null; try { Clipboard.SetText(text, TextDataFormat.UnicodeText); Send(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0x11 } } }, new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0x56 } } }, new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0x56, dwFlags = KEYEVENTF_KEYUP } } }, new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0x11, dwFlags = KEYEVENTF_KEYUP } } }); Thread.Sleep(80); } finally { if (hadText) Clipboard.SetText(previous, TextDataFormat.UnicodeText); else Clipboard.Clear(); } }
  static object TypeText() { var targetApp = Text("targetApp"); if (!String.IsNullOrWhiteSpace(targetApp)) FocusWindow(targetApp); if (Input.ContainsKey("x") && Input.ContainsKey("y")) Click(); var foreground = RequireForeground(targetApp); var text = Text("text"); var inputMethod = "unicode-sendinput"; if (RequiresUnicodePaste(text)) { PasteUnicodeText(text); inputMethod = "unicode-clipboard-paste"; } else { foreach (var c in text) { SendUnicode(c, false); SendUnicode(c, true); } } var submitted = Flag("pressEnter"); if (submitted) PressVirtualKey(0x0D, false); return new Dictionary<string, object> { { "typed", text.Length }, { "submitted", submitted }, { "inputMethod", inputMethod }, { "foreground", foreground } }; }
  static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> { { "control", 0x11 }, { "ctrl", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B }, { "meta", 0x5B }, { "command", 0x5B }, { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "esc", 0x1B }, { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x2E }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 } };
  static ushort VirtualKey(string raw) { var key = (raw ?? "").Trim().ToLowerInvariant(); ushort code; if (Keys.TryGetValue(key, out code)) return code; if (key.Length == 1 && key[0] >= 'a' && key[0] <= 'z') return (ushort)Char.ToUpperInvariant(key[0]); if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return (ushort)key[0]; if (key.StartsWith("f")) { int n; if (Int32.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1); } throw new InvalidOperationException("unsupported key " + raw); }
  static void PressVirtualKey(ushort key, bool modifiers) { Send(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = key } } }, new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP } } }); }
  static object PressKeys() { var entries = Input.ContainsKey("keys") ? Input["keys"] as ArrayList : null; if (entries == null || entries.Count == 0) throw new InvalidOperationException("keys are required"); var foreground = RequireForeground(Text("targetApp")); var codes = new List<ushort>(); foreach (var value in entries) codes.Add(VirtualKey(Convert.ToString(value))); for (var i = 0; i < codes.Count - 1; i++) Send(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = codes[i] } } }); PressVirtualKey(codes[codes.Count - 1], false); for (var i = codes.Count - 2; i >= 0; i--) Send(new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = codes[i], dwFlags = KEYEVENTF_KEYUP } } }); return new Dictionary<string, object> { { "pressed", true }, { "foreground", foreground } }; }
  static object Scroll() { var x = Number("x"); var y = Number("y"); SetCursorPos(x, y); var vertical = Number("deltaY"); var horizontal = Number("deltaX"); var events = new List<INPUT>(); events.Add(Mouse(MOUSEEVENTF_MOVE, x, y)); if (vertical != 0) events.Add(Mouse(MOUSEEVENTF_WHEEL, x, y, unchecked((uint)vertical))); if (horizontal != 0) events.Add(Mouse(MOUSEEVENTF_HWHEEL, x, y, unchecked((uint)horizontal))); Send(events.ToArray()); return new Dictionary<string, object> { { "scrolled", true } }; }
  static Dictionary<string, object> Element(AutomationElement element, int depth, ref int count, int maxDepth) { if (count++ >= MAX_AUTOMATION_NODES || depth > maxDepth) return null; AutomationElement.AutomationElementInformation info; try { info = element.Current; } catch { return null; } var children = new List<object>(); var walker = TreeWalker.ControlViewWalker; var child = walker.GetFirstChild(element); while (child != null && count < MAX_AUTOMATION_NODES) { var node = Element(child, depth + 1, ref count, maxDepth); if (node != null) children.Add(node); child = walker.GetNextSibling(child); }
    return new Dictionary<string, object> { { "role", info.ControlType == null ? "UIA" : info.ControlType.ProgrammaticName }, { "title", info.Name }, { "value", "" }, { "description", info.AutomationId }, { "enabled", info.IsEnabled }, { "focused", info.HasKeyboardFocus }, { "bounds", Bounds(info.BoundingRectangle) }, { "children", children } }; }
  static object Accessibility() { var hwnd = GetForegroundWindow(); if (hwnd == IntPtr.Zero) return new Dictionary<string, object> { { "pid", 0 }, { "appName", "unknown" }, { "root", null }, { "truncated", false } }; int pid; var app = AppName(hwnd, out pid); var rootElement = AutomationElement.FromHandle(hwnd); var count = 0; var root = Element(rootElement, 0, ref count, Math.Max(1, Number("maxDepth", 12))); return new Dictionary<string, object> { { "pid", pid }, { "appName", app }, { "root", root }, { "truncated", count >= MAX_AUTOMATION_NODES } }; }
  static object Run(string command) { switch (command) { case "observe-windows": return ObserveWindows(); case "list-processes": return ListProcesses(); case "foreground": return Foreground(); case "display-info": return DisplayInfo(); case "screenshot": return Screenshot(); case "open-app": return OpenApp(); case "focus-app": return FocusApp(); case "click": return Click(); case "type-text": return TypeText(); case "press-keys": return PressKeys(); case "scroll": return Scroll(); case "accessibility": return Accessibility(); default: throw new InvalidOperationException("unsupported command " + command); } }
  [STAThread] public static void Main(string[] args) { try { AttachInputDesktop(); Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = Encoding.UTF8; if (args.Length != 1) throw new InvalidOperationException("one command argument is required"); Input = ReadInput(); Console.WriteLine(Json.Serialize(Run(args[0]))); } catch (Exception error) { Console.Error.WriteLine(error.ToString()); Environment.ExitCode = 1; } }
}
`

const helperPromises = new Map<string, Promise<string>>()

function compilerCandidates() {
  const windowsDir = env.WINDIR || 'C:\\Windows'
  return [
    env.COMPUTER_USE_WINDOWS_CSC,
    join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    'csc.exe',
  ].filter((candidate): candidate is string => Boolean(candidate))
}

async function compileHelper(config: ComputerUseConfig) {
  if (platform !== 'win32')
    throw new Error('windows-local executor requires Windows')

  const digest = createHash('sha256').update(helperSource).digest('hex').slice(0, 16)
  const helperDir = join(config.sessionRoot, 'native')
  const sourcePath = join(helperDir, `windows-computer-use-${digest}.cs`)
  const executablePath = join(helperDir, `windows-computer-use-${digest}.exe`)
  if (existsSync(executablePath))
    return executablePath

  await mkdir(helperDir, { recursive: true })
  await writeFile(sourcePath, helperSource, 'utf8')

  const windowsDir = env.WINDIR || 'C:\\Windows'
  const automationAssemblyRoot = join(windowsDir, 'Microsoft.NET', 'assembly', 'GAC_MSIL')
  const args = [
    '/nologo',
    '/target:exe',
    `/out:${executablePath}`,
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    `/reference:${join(automationAssemblyRoot, 'WindowsBase', 'v4.0_4.0.0.0__31bf3856ad364e35', 'WindowsBase.dll')}`,
    `/reference:${join(automationAssemblyRoot, 'UIAutomationClient', 'v4.0_4.0.0.0__31bf3856ad364e35', 'UIAutomationClient.dll')}`,
    `/reference:${join(automationAssemblyRoot, 'UIAutomationTypes', 'v4.0_4.0.0.0__31bf3856ad364e35', 'UIAutomationTypes.dll')}`,
    sourcePath,
  ]
  const failures: string[] = []
  for (const compiler of compilerCandidates()) {
    try {
      await runProcess(compiler, args, { timeoutMs: Math.max(config.timeoutMs, 30_000) })
      return executablePath
    }
    catch (error) {
      failures.push(`${compiler}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`Windows Computer Use helper could not be compiled. ${failures.join(' | ')}`)
}

async function helperPath(config: ComputerUseConfig) {
  const existing = helperPromises.get(config.sessionRoot)
  if (existing)
    return await existing

  const pending = compileHelper(config)
  helperPromises.set(config.sessionRoot, pending)
  try {
    return await pending
  }
  catch (error) {
    helperPromises.delete(config.sessionRoot)
    throw error
  }
}

export async function runWindowsHelper<T>(config: ComputerUseConfig, command: string, input: object = {}): Promise<T> {
  const executable = await helperPath(config)
  const { stdout } = await runProcess(executable, [command], {
    stdin: JSON.stringify(input),
    timeoutMs: config.timeoutMs,
  })
  return JSON.parse(stdout.trim()) as T
}
