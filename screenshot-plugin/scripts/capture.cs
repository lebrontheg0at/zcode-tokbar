// ZCode 截图监听器：全局热键或命令触发 -> 冻结整屏为位图 -> 在冻结图上框选 -> 从冻结图裁剪保存
// 纯 Win32 消息循环（无 WinForms，省内存）；System.Drawing 仅用于 GDI+ 截屏与 PNG 编码。
// 懒启动（由 capture.ps1 编译并拉起），空闲或 ZCode 进程退出后自动退出；互斥锁保证单实例。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

namespace ZCodeShot
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern ushort RegisterClassW(ref WNDCLASS wc);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style,
            int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint crKey, byte alpha, uint flags);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr h, uint id);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll")] static extern bool EmptyClipboard();
        [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr data);
        [DllImport("user32.dll")] static extern bool CloseClipboard();
        [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint color);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);

        delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WNDCLASS
        {
            public uint style;
            public WndProc lpfnWndProc;
            public int cbClsExtra, cbWndExtra;
            public IntPtr hInstance, hIcon, hCursor, hbrBackground;
            public string lpszMenuName, lpszClassName;
        }
        struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int ptX, ptY; }
        struct RECT { public int Left, Top, Right, Bottom; }

        static readonly string BaseDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".zcode", "screenshot");
        static readonly string ConfigPath = Path.Combine(BaseDir, "config.json");
        static readonly string ShotsDir = Path.Combine(BaseDir, "shots");
        static readonly string LatestPath = Path.Combine(BaseDir, "latest.txt");
        static readonly string HotkeyErrorPath = Path.Combine(BaseDir, "hotkey-error.log");

        static EventWaitHandle _trigger, _reload;

        const int HotkeyId = 0xB00B;       // 截图（不隐藏窗口）
        const int EscHotkeyId = 0xB00C;    // 框选期间临时占用 ESC（遮罩不抢焦点，收不到按键）
        const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8;
        const uint WM_HOTKEY = 0x0312, WM_TIMER = 0x0113, WM_DESTROY = 0x0002,
            WM_KEYDOWN = 0x0100, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_MOUSEMOVE = 0x0200,
            WM_RBUTTONDOWN = 0x0204, WM_MOUSEACTIVATE = 0x0021;
        const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_SHOW = 5, SW_RESTORE = 9;
        const int MA_NOACTIVATE = 3;

        static readonly WndProc MsgWndProc = MsgProc;   // 静态引用防止委托被 GC
        static readonly WndProc OverlayWndProc = OverlayProc;
        static IntPtr _msgHwnd, _overlay;

        static uint _mods = MOD_CONTROL | MOD_ALT;
        static uint _vk = (uint)'A';
        static DateTime _lastActive = DateTime.Now;
        static bool _capturing = false; // 防重入：遮罩开着时忽略新的热键/触发，避免叠出多层遮罩
        static int _zcodeGoneTicks = 0; // ZCode 进程消失的连续检测次数

        // 框选状态
        static Rectangle _result = Rectangle.Empty;
        static Point _start, _end;
        static bool _dragging;
        static Rectangle _vs;              // 虚拟屏幕范围
        static Bitmap _layerBuf;           // 遮罩 ARGB 缓冲：半透明黑 + 不透明绿色选框
        static Bitmap _frozen;             // 触发瞬间的整屏快照：框选期间画面"暂停"，从它裁剪
        static Graphics _layerGfx;

        static void Dbg(string s) { try { File.AppendAllText(Path.Combine(BaseDir, "debug.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n"); } catch { } }

        static IntPtr MsgProc(IntPtr h, uint m, IntPtr w, IntPtr l)
        {
            try { return MsgProcInner(h, m, w, l); }
            catch (Exception ex) { Dbg("MsgProc EXCEPTION: " + ex); return DefWindowProcW(h, m, w, l); }
        }
        static IntPtr MsgProcInner(IntPtr h, uint m, IntPtr w, IntPtr l)
        {
            if (m == WM_HOTKEY)
            {
                int id = w.ToInt32();
                if (id == EscHotkeyId)
                {
                    // 框选期间按 ESC = 取消（遮罩不抢焦点，只能靠全局热键收到）
                    if (_capturing && _overlay != IntPtr.Zero)
                    {
                        Dbg("esc -> cancel");
                        _result = Rectangle.Empty;
                        _dragging = false;
                        DestroyWindow(_overlay);
                    }
                    return IntPtr.Zero;
                }
                Dbg("hotkey id=" + id); _lastActive = DateTime.Now; DoCapture(); return IntPtr.Zero;
            }
            if (m == WM_TIMER)
            {
                try
                {
                    // 遮罩不抢焦点 → 收不到按键消息，靠这个 200ms 定时器轮询 ESC 物理按键状态来取消
                    if (_capturing && _overlay != IntPtr.Zero && (GetAsyncKeyState(0x1B) & 0x8000) != 0)
                    {
                        Dbg("esc -> cancel");
                        _result = Rectangle.Empty;
                        _dragging = false;
                        DestroyWindow(_overlay);
                        return IntPtr.Zero;
                    }
                    if (_reload.WaitOne(0))
                    {
                        UnregisterHotKey(h, HotkeyId);
                        LoadConfig();
                        LogHotkeyFailure(RegisterHotKey(h, HotkeyId, _mods, _vk), true);
                    }
                    if (_trigger.WaitOne(0)) { Dbg("trigger"); _lastActive = DateTime.Now; DoCapture(); } // 脚本触发
                    else
                    {
                        // 每 5 秒检查一次：ZCode 进程连续 60 秒不存在则退出；idleMinutes>0 时空闲超时也退出
                        if (++_zcodeGoneTicks >= 25)
                        {
                            _zcodeGoneTicks = 0;
                            if (!ZCodeRunning()) { _zcodeGoneSeconds++; if (_zcodeGoneSeconds >= 12) { Application_Exit(); } }
                            else _zcodeGoneSeconds = 0;
                        }
                        var idle = IdleMinutes();
                        if (idle > 0 && (DateTime.Now - _lastActive).TotalMinutes > idle) Application_Exit();
                    }
                }
                catch { }
                return IntPtr.Zero;
            }
            if (m == WM_DESTROY) return IntPtr.Zero;
            return DefWindowProcW(h, m, w, l);
        }
        static Point _lastLoggedMove = new Point(int.MinValue, int.MinValue);
        static int _zcodeGoneSeconds = 0;

        // 热键注册失败（多半被其他软件占用）不会静默：写日志，capture.ps1 状态 会显示
        static void LogHotkeyFailure(bool ok, bool _)
        {
            if (ok) { try { File.Delete(HotkeyErrorPath); } catch { } return; }
            try
            {
                File.WriteAllText(HotkeyErrorPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
                    + " 热键注册失败（可能被其他程序占用）");
            }
            catch { }
        }

        static bool ZCodeRunning()        {
            try { return Process.GetProcessesByName("zcode").Length > 0 || Process.GetProcessesByName("ZCode").Length > 0; }
            catch { return true; } // 检测失败时保守处理：不退出
        }

        static void Application_Exit()
        {
            UnregisterHotKey(_msgHwnd, HotkeyId);
            DestroyWindow(_msgHwnd);
            Environment.Exit(0);
        }

        // 全屏框选遮罩：拖出矩形后保存，ESC 取消
        static IntPtr OverlayProc(IntPtr h, uint m, IntPtr w, IntPtr l)
        {
            try { return OverlayProcInner(h, m, w, l); }
            catch (Exception ex) { Dbg("OverlayProc EXCEPTION: " + ex); return DefWindowProcW(h, m, w, l); }
        }
        static IntPtr OverlayProcInner(IntPtr h, uint m, IntPtr w, IntPtr l)
        {
            switch (m)
            {
                case WM_MOUSEACTIVATE:
                    // 鼠标点在遮罩上时不要激活它：ZCode 保持前台，也就不会因为失焦被隐藏/最小化
                    return (IntPtr)MA_NOACTIVATE;
                case WM_KEYDOWN:
                    if (w.ToInt32() == 0x1B) { _result = Rectangle.Empty; DestroyWindow(h); }
                    return IntPtr.Zero;
                case WM_LBUTTONDOWN:
                    Dbg("lbtn down");
                    _dragging = true;
                    _start = _end = ToPoint(l);
                    SetCapture(h); // 拖动时保持鼠标消息不丢失
                    return IntPtr.Zero;
                case WM_MOUSEMOVE:
                    if (_dragging)
                    {
                        _end = ToPoint(l);
                        if (!_lastLoggedMove.Equals(_end)) { Dbg("move " + _end); _lastLoggedMove = _end; }
                        UpdateOverlay(h);
                    }
                    return IntPtr.Zero;
                case WM_RBUTTONDOWN:
                    // 右键取消框选，等同 ESC
                    Dbg("rbtn down -> cancel");
                    if (_dragging) { _dragging = false; ReleaseCapture(); }
                    _result = Rectangle.Empty;
                    ShowWindow(h, SW_HIDE);
                    DestroyWindow(h);
                    return IntPtr.Zero;
                case WM_LBUTTONUP:
                    Dbg("lbtn up");
                    if (!_dragging) return IntPtr.Zero;
                    _dragging = false;
                    _end = ToPoint(l);
                    ReleaseCapture();
                    _result = Normalize(_start, _end);
                    if (_result.Width < 2 || _result.Height < 2) _result = Rectangle.Empty;
                    ShowWindow(h, SW_HIDE); // 先隐藏遮罩再截屏，避免把遮罩截进去
                    DestroyWindow(h);       // 必须销毁，否则消息循环永远不返回
                    return IntPtr.Zero;
                default:
                    return DefWindowProcW(h, m, w, l);
            }
        }

        [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
        [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, IntPtr proc);

        static Point ToPoint(IntPtr l)
        {
            int x = (short)((long)l & 0xFFFF);
            int y = (short)(((long)l >> 16) & 0xFFFF);
            return new Point(x, y);
        }

        static Rectangle Normalize(Point a, Point b)
        {
            return new Rectangle(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
        }

        // UpdateLayeredWindow 绘制：整个遮罩 = 35% 黑色；当前选区边框 = 不透明亮绿 3px。
        // 逐像素 alpha 不受窗口级半透明影响，选框颜色所见即所得。
        struct POINT { public int X, Y; }
        struct SIZE { public int W, H; }
        struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [DllImport("user32.dll")]
        static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pptSrc, uint crKey, ref BLENDFUNCTION bf, uint dwFlags);

        static void UpdateOverlay(IntPtr h)
        {
            if (_layerBuf == null)
            {
                _layerBuf = new Bitmap(_vs.Width, _vs.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                _layerGfx = Graphics.FromImage(_layerBuf);
            }
            if (_frozen != null)
            {
                // 画冻结快照（完全不透明）-> 屏幕看起来被“暂停”
                _layerGfx.DrawImage(_frozen, new Rectangle(0, 0, _vs.Width, _vs.Height),
                    new Rectangle(0, 0, _frozen.Width, _frozen.Height), GraphicsUnit.Pixel);
                using (var dim = new SolidBrush(Color.FromArgb(90, 0, 0, 0)))
                    _layerGfx.FillRectangle(dim, 0, 0, _vs.Width, _vs.Height);
            }
            else
            {
                _layerGfx.Clear(Color.FromArgb(90, 0, 0, 0)); // 无快照时退回旧的半透明遮罩
            }
            if (_dragging)
            {
                var r = Normalize(_start, _end);
                if (!r.IsEmpty)
                {
                    if (_frozen != null) // 选区内恢复原亮度（不压暗）
                        _layerGfx.DrawImage(_frozen, new Rectangle(r.X, r.Y, r.Width, r.Height), r, GraphicsUnit.Pixel);
                    using (var p = new Pen(Color.White, 1))
                        _layerGfx.DrawRectangle(p, r);
                }
            }
            IntPtr hdcScreen = GetDC(IntPtr.Zero);
            if (hdcScreen == IntPtr.Zero) return;
            IntPtr hbm = IntPtr.Zero, hdcMem = IntPtr.Zero, oldBmp = IntPtr.Zero;
            try
            {
                hdcMem = CreateCompatibleDC(hdcScreen);
                hbm = _layerBuf.GetHbitmap(Color.FromArgb(0));
                oldBmp = SelectObject(hdcMem, hbm);
                var dst = new POINT { X = _vs.X, Y = _vs.Y };
                var size = new SIZE { W = _vs.Width, H = _vs.Height };
                var src = new POINT { X = 0, Y = 0 };
                var bf = new BLENDFUNCTION { BlendOp = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                UpdateLayeredWindow(h, hdcScreen, ref dst, ref size, hdcMem, ref src, 0, ref bf, 2 /*ULW_ALPHA*/);
            }
            catch (Exception ex) { Dbg("UpdateOverlay EXCEPTION: " + ex.Message); }
            finally
            {
                if (oldBmp != IntPtr.Zero) SelectObject(hdcMem, oldBmp);
                if (hbm != IntPtr.Zero) DeleteObject(hbm);
                if (hdcMem != IntPtr.Zero) DeleteDC(hdcMem);
                ReleaseDC(IntPtr.Zero, hdcScreen);
            }
        }

        [STAThread]
        static void Main()
        {
            SetProcessDPIAware();
            Directory.CreateDirectory(ShotsDir);
            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\ZCodeShotMutex", out createdNew))
            {
                if (!createdNew) return; // 已有实例在运行
                _trigger = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\ZCodeShotTrigger");
                _reload = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\ZCodeShotReload");
                LoadConfig();

                var overlayClass = new WNDCLASS
                {
                    lpfnWndProc = OverlayWndProc,
                    hInstance = GetModuleHandleW(null),
                    lpszClassName = "ZCodeShotOverlay",
                    hCursor = LoadCursor(IntPtr.Zero, 32515) // IDC_CROSS
                };
                RegisterClassW(ref overlayClass);

                var msgClass = new WNDCLASS
                {
                    lpfnWndProc = MsgWndProc,
                    hInstance = GetModuleHandleW(null),
                    lpszClassName = "ZCodeShotMsg"
                };
                RegisterClassW(ref msgClass);
                // HWND_MESSAGE：纯消息窗口，不可见、不占任务栏
                _msgHwnd = CreateWindowExW(0, "ZCodeShotMsg", "ZCodeShot", 0, 0, 0, 0, 0,
                    (IntPtr)(-3), IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
                if (_msgHwnd == IntPtr.Zero) return;

                bool ok = RegisterHotKey(_msgHwnd, HotkeyId, _mods, _vk);
                LogHotkeyFailure(ok, true);
                SetTimer(_msgHwnd, (UIntPtr)1, 200, IntPtr.Zero);

                MSG msg;
                while (GetMessageW(out msg, IntPtr.Zero, 0, 0))
                {
                    TranslateMessage(ref msg);
                    DispatchMessageW(ref msg);
                }
            }
        }

        static void DoCapture()
        {
            if (_capturing) return; // 已有遮罩在框选，忽略重复触发
            _capturing = true;
            try
            {
                _lastActive = DateTime.Now;
                var prevWindow = GetForegroundWindow();
                Bitmap savedBitmap = RunOverlay();
                if (savedBitmap != null)
                {
                    PasteToPreviousWindow(prevWindow, savedBitmap);
                    savedBitmap.Dispose();
                }
            }
            finally
            {
                _capturing = false;
            }
        }

        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

        // 遮罩不抢焦点，收不到键盘消息 → ESC 由 200ms 的 WM_TIMER 轮询物理按键状态来取消（见 MsgProc）。
        // 消息循环保持原来的阻塞写法，拖动框选的路径完全没变。
        static void PumpUntilClosed()
        {
            MSG msg;
            while (IsWindow(_overlay) && GetMessageW(out msg, IntPtr.Zero, 0, 0))
            {
                TranslateMessage(ref msg);
                DispatchMessageW(ref msg);
            }
        }

        // 显示遮罩并跑独立消息循环，返回截图（null = 取消/无效选区）
        static Bitmap RunOverlay()
        {
            _result = Rectangle.Empty;
            _dragging = false;
            _vs = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
            try
            {
                _frozen = new Bitmap(_vs.Width, _vs.Height);
                using (var g = Graphics.FromImage(_frozen))
                    g.CopyFromScreen(_vs.X, _vs.Y, 0, 0, new Size(_vs.Width, _vs.Height));
            }
            catch (Exception ex) { Dbg("freeze FAILED: " + ex.Message); _frozen = null; }
            // WS_EX_NOACTIVATE：遮罩出现/点击都不抢焦点。ZCode 因此始终是前台窗口，
            // 不会被它自己的“失焦即收进托盘/最小化”逻辑藏起来（截完图界面消失的老问题）。
            _overlay = CreateWindowExW(0x08080088 /*TOPMOST|TOOLWINDOW|LAYERED|NOACTIVATE*/, "ZCodeShotOverlay", "", 0x80000000 /*WS_POPUP*/,
                _vs.X, _vs.Y, _vs.Width, _vs.Height, IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
            if (_overlay == IntPtr.Zero) { Dbg("overlay create FAILED"); return null; }
            ShowWindow(_overlay, SW_SHOWNOACTIVATE);
            UpdateOverlay(_overlay); // 立即呈现遮罩底色
            Dbg("overlay shown");
            PumpUntilClosed();
            _overlay = IntPtr.Zero;
            if (_layerGfx != null) { _layerGfx.Dispose(); _layerGfx = null; }
            if (_layerBuf != null) { _layerBuf.Dispose(); _layerBuf = null; }
            Dbg("overlay closed, result=" + (_result.IsEmpty ? "empty" : _result.ToString()) + (_frozen != null ? " frozen" : " live"));
            if (_result.IsEmpty) { if (_frozen != null) { _frozen.Dispose(); _frozen = null; } return null; }
            try
            {
                if (_frozen != null)
                {
                    var crop = new Bitmap(_result.Width, _result.Height);
                    using (var g = Graphics.FromImage(crop))
                        g.DrawImage(_frozen, new Rectangle(0, 0, crop.Width, crop.Height), _result, GraphicsUnit.Pixel);
                    _frozen.Dispose(); _frozen = null;
                    return Persist(crop);
                }
                Thread.Sleep(120); // 无快照时退回旧路径：等桌面合成器完成遮罩消失后的重绘
                return SaveRegion(new Rectangle(_vs.X + _result.X, _vs.Y + _result.Y, _result.Width, _result.Height));
            }
            catch { return null; }
            finally { if (_frozen != null) { _frozen.Dispose(); _frozen = null; } }
        }

        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr SetCapture(IntPtr h);
        [DllImport("user32.dll")] static extern bool ReleaseCapture();

        static void WaitForeground(IntPtr h, int timeoutMs)
        {
            for (int waited = 0; GetForegroundWindow() != h && waited < timeoutMs; waited += 20)
            {
                Thread.Sleep(20);
                SetForegroundWindow(h);
            }
        }

        // 保存 PNG 落盘并记录 latest.txt，返回位图供粘贴（由调用方负责 Dispose）
        static Bitmap Persist(Bitmap bmp)
        {
            var file = Path.Combine(ShotsDir, "shot_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".png");
            bmp.Save(file, ImageFormat.Png);
            File.WriteAllText(LatestPath, file);
            return bmp;
        }

        public static Bitmap SaveRegion(Rectangle r)
        {
            var bmp = new Bitmap(r.Width, r.Height);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size);
            }
            return Persist(bmp);
        }

        // 截图完成后把图片粘贴进 ZCode 输入框。ZCode 不在前台（如最小化/收进托盘）时先呼出它。
        static void PasteToPreviousWindow(IntPtr prevHwnd, Bitmap bmp)
        {
            try
            {
                if (bmp == null || !AutoInsert()) return;
                // 目标窗口：前台是 ZCode 就用它；否则找到 ZCode 主窗口并呼出（还原最小化/切换前台）
                IntPtr target = prevHwnd;
                if (!IsZCodeWindow(target))
                {
                    target = FindZCodeWindow();
                    if (target == IntPtr.Zero) { Dbg("paste: no zcode window, skip"); return; }
                    Dbg("paste: summoning zcode iconic=" + IsIconic(target) + " visible=" + IsWindowVisible(target));
                }
                EnsureVisible(target);
                NudgeRepaint(target);
                ForceForeground(target);
                WaitForeground(target, 1000);
                EnsureVisible(target);
                NudgeRepaint(target);
                if (GetForegroundWindow() != target) { ForceForeground(target); EnsureVisible(target); } // 再抢一次
                Dbg("paste: foreground ok iconic=" + IsIconic(target) + " visible=" + IsWindowVisible(target));
                // 点击校准过的输入框位置点亮光标（/screenshot 校准 记录），未校准则直接粘贴到当前焦点
                bool isZCode = IsZCodeWindow(target);
                RECT r;
                bool hasRect = GetWindowRect(target, out r);
                double fx = MatchNumber("pasteClickX", 0.5);
                double yFromBottom = MatchNumber("pasteClickYFromBottom", 165);
                Dbg("paste: zcode=" + isZCode + " pasteClickX=" + fx);
                if (isZCode && hasRect && fx >= 0 && fx <= 1)
                {
                    int cx = (int)(r.Left + (r.Right - r.Left) * fx);
                    int cy = r.Bottom - (int)yFromBottom;
                    Dbg("paste: click " + cx + "," + cy);
                    // 点击后确认前台仍在 ZCode；用户在这几百毫秒里点了别处就重试一次
                    for (int attempt = 0; attempt < 2; attempt++)
                    {
                        LeftClick(cx, cy);
                        Thread.Sleep(100);
                        if (GetForegroundWindow() == target) break;
                        Dbg("paste: foreground changed after click, retrying");
                        SetForegroundWindow(target);
                        WaitForeground(target, 500);
                    }
                }
                SetClipboardBitmap(bmp);
                keybd_event(0x11, 0, 0, UIntPtr.Zero);      // Ctrl down
                Thread.Sleep(30);
                keybd_event(0x56, 0, 0, UIntPtr.Zero);      // V down
                keybd_event(0x56, 0, 2, UIntPtr.Zero);      // V up
                Thread.Sleep(30);
                keybd_event(0x11, 0, 2, UIntPtr.Zero);      // Ctrl up
                Dbg("paste: Ctrl+V sent");
            }
            catch (Exception ex) { Dbg("paste EXCEPTION: " + ex.Message); }
        }

        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

        // Electron 窗口从托盘隐藏态被原生 ShowWindow 拉起时，Chromium 合成器常不恢复出帧 → 整窗纯黑。
        // 强做一次 ±1px 的尺寸抖动，让它重走一遍可见性/合成路径。
        static void NudgeRepaint(IntPtr h)
        {
            if (h == IntPtr.Zero) return;
            RECT r;
            if (!GetWindowRect(h, out r)) return;
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            const uint SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_FRAMECHANGED = 0x20;
            SetWindowPos(h, IntPtr.Zero, 0, 0, w, ht + 1, SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED);
            SetWindowPos(h, IntPtr.Zero, 0, 0, w, ht, SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED);
            Dbg("repaint nudge applied");
        }

        // 兜底：ZCode 若真的被藏起来/最小化（它自己的失焦收托盘逻辑），这里强制还原
        static void EnsureVisible(IntPtr h)
        {
            if (h == IntPtr.Zero) return;
            for (int i = 0; i < 3; i++)
            {
                if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
                if (IsWindowVisible(h) && !IsIconic(h)) return;
                ShowWindow(h, 1 /*SW_SHOWNORMAL*/);
                ShowWindow(h, SW_RESTORE);
                ShowWindow(h, SW_SHOW);
                Thread.Sleep(60);
                if (IsWindowVisible(h) && !IsIconic(h)) return;
            }
            Dbg("EnsureVisible: still hidden, iconic=" + IsIconic(h) + " visible=" + IsWindowVisible(h));
        }

        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

        // 按进程枚举顶层窗口找 ZCode 主窗口：Process.MainWindowHandle 在窗口被隐藏时会返回 0，
        // 而“隐藏后要还原”正是这个函数最重要的场景，所以不能只靠它。
        static IntPtr FindZCodeWindow()
        {
            System.Collections.Generic.HashSet<uint> pids = new System.Collections.Generic.HashSet<uint>();
            try
            {
                foreach (var name in new[] { "zcode", "ZCode" })
                    foreach (var p in Process.GetProcessesByName(name)) pids.Add((uint)p.Id);
            }
            catch { }
            if (pids.Count == 0) return IntPtr.Zero;

            IntPtr best = IntPtr.Zero;
            long bestArea = -1;
            bool bestVisible = false;
            EnumWindowsProc cb = delegate (IntPtr h, IntPtr l)
            {
                try
                {
                    uint pid;
                    GetWindowThreadProcessId(h, out pid);
                    if (!pids.Contains(pid)) return true;
                    RECT r;
                    if (!GetWindowRect(h, out r)) return true;
                    long w = r.Right - r.Left, hh = r.Bottom - r.Top;
                    if (w < 300 || hh < 200) return true;   // 跳过托盘/工具/隐藏的辅助窗口
                    bool vis = IsWindowVisible(h);
                    long area = w * hh;
                    if (best == IntPtr.Zero || (vis && !bestVisible) || (vis == bestVisible && area > bestArea))
                    {
                        best = h; bestArea = area; bestVisible = vis;
                    }
                }
                catch { }
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            return best;
        }

        // 可靠抢前台：AttachThreadInput 暂时把前台线程与目标线程连起来，绕过系统前台锁定。
        // Electron（ZCode）直接 SetForegroundWindow 时常失败，这是桌面应用呼出窗口的标准做法。
        static void ForceForeground(IntPtr h)
        {
            uint pid;
            uint cur = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            uint me = GetCurrentThreadId();
            uint them = GetWindowThreadProcessId(h, out pid);
            if (cur != me) AttachThreadInput(me, cur, true);
            AttachThreadInput(me, them, true);
            EnsureVisible(h);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (cur != me) AttachThreadInput(me, cur, false);
            AttachThreadInput(me, them, false);
        }

        // 原生剪贴板：写入 CF_DIB（Electron/多数应用读取的格式）。BMP 文件去掉 14 字节文件头即为 DIB。
        static void SetClipboardBitmap(Bitmap bmp)
        {
            IntPtr hGlobal = IntPtr.Zero;
            try
            {
                byte[] dib;
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Bmp);
                    byte[] file = ms.ToArray();
                    dib = new byte[file.Length - 14];
                    Array.Copy(file, 14, dib, 0, dib.Length);
                }
                hGlobal = Marshal.AllocHGlobal(dib.Length);
                Marshal.Copy(dib, 0, hGlobal, dib.Length);
                if (OpenClipboard(IntPtr.Zero))
                {
                    try
                    {
                        EmptyClipboard();
                        if (SetClipboardData(8 /*CF_DIB*/, hGlobal) == IntPtr.Zero) throw new Exception("SetClipboardData failed");
                        hGlobal = IntPtr.Zero; // 成功后归剪贴板所有
                    }
                    finally { CloseClipboard(); }
                }
            }
            catch (Exception ex) { Dbg("clipboard: " + ex.Message); }
            finally { if (hGlobal != IntPtr.Zero) Marshal.FreeHGlobal(hGlobal); }
        }

        static bool IsZCodeWindow(IntPtr hwnd)
        {
            try
            {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                var proc = Process.GetProcessById((int)pid);
                return proc.ProcessName.ToLowerInvariant().Contains("zcode");
            }
            catch { return false; }
        }

        // 模拟点击：与用户真鼠标存在竞争（用户移动会把光标拉回去），因此点击前校验光标到位、
        // 点击后校验前台窗口未变，失败自动重试
        static void LeftClick(int x, int y)
        {
            var target = new POINT { X = x, Y = y };
            for (int attempt = 0; attempt < 3; attempt++)
            {
                SetCursorPos(x, y);
                var now = new POINT();
                GetCursorPos(out now);
                if (Math.Abs(now.X - x) > 2 || Math.Abs(now.Y - y) > 2) continue; // 被真鼠标拉走了，重新定位
                mouse_event(2, 0, 0, 0, UIntPtr.Zero); // LEFTDOWN
                mouse_event(4, 0, 0, 0, UIntPtr.Zero); // LEFTUP
                return;
            }
        }

        static bool AutoInsert()
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                var m = Regex.Match(json, "\"autoInsert\"\\s*:\\s*(true|false)");
                if (m.Success) return m.Groups[1].Value == "true";
            }
            catch { }
            return true;
        }

        static double IdleMinutes()
        {
            // 默认 0 = 不启用空闲退出（ZCode 运行期间监听器常驻，热键始终可用）
            return MatchNumber("idleMinutes", 0);
        }

        static double MatchNumber(string key, double def)
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*([0-9.]+)");
                if (m.Success) return double.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            }
            catch { }
            return def;
        }

        static void LoadConfig()
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                var m = Regex.Match(json, "\"hotkey\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success && ParseHotkey(m.Groups[1].Value, out _mods, out _vk)) { }
                else ParseHotkey("Ctrl+Alt+A", out _mods, out _vk);
            }
            catch
            {
                ParseHotkey("Ctrl+Alt+A", out _mods, out _vk);
            }
        }

        static bool ParseHotkey(string text, out uint mods, out uint vk)
        {
            mods = 0;
            vk = 0;
            foreach (var raw in text.Split('+'))
            {
                var p = raw.Trim().ToLowerInvariant();
                if (p == "") continue;
                if (p == "ctrl" || p == "control") mods |= MOD_CONTROL;
                else if (p == "alt") mods |= MOD_ALT;
                else if (p == "shift") mods |= MOD_SHIFT;
                else if (p == "win") mods |= MOD_WIN;
                else if (p.Length == 1 && char.IsLetter(p[0])) vk = (uint)char.ToUpper(p[0]);
                else if (p.Length == 1 && char.IsDigit(p[0])) vk = (uint)p[0];
                else if (p[0] == 'f' && p.Length <= 3)
                {
                    int n;
                    if (int.TryParse(p.Substring(1), out n) && n >= 1 && n <= 24) vk = (uint)(0x70 + n - 1);
                }
            }
            return vk != 0;
        }
    }
}
