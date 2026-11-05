// Aster: Claude's little desktop pet. A borderless, always-on-top window whose
// empty pixels let clicks through. Drag to move, click to pet, double-click for
// a snack, wheel to resize, right-click for the menu.
//
// It reads status.json, which the Claude Code plugin writes as Claude works, and
// keeps its own settings.json, both beside the exe. The art is built into the exe.

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace Aster
{
    public class Manifest
    {
        public int w;
        public int h;
        public int icon;
        public Dictionary<string, int[][]> anims;
        public Dictionary<string, int> icons;
    }

    // What art.mjs drew, read from the resources compiled into the exe.
    public class Art
    {
        public Manifest Manifest;
        public BitmapSource[] Frames;
        BitmapSource[] icons;

        public BitmapSource Icon(string name) { return icons[Manifest.icons[name]]; }

        public static Art Load()
        {
            var art = new Art();
            using (var stream = Resource("manifest.json"))
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                art.Manifest = new JavaScriptSerializer().Deserialize<Manifest>(reader.ReadToEnd());
            }
            art.Frames = Cut(Picture("sheet.png"), art.Manifest.w, art.Manifest.h);
            art.icons = Cut(Picture("icons.png"), art.Manifest.icon, art.Manifest.icon);

            return art;
        }

        // Aster from spark to toes in this mood, without the empty canvas around them.
        public BitmapSource Portrait(string animation)
        {
            int[][] steps;
            if (!Manifest.anims.TryGetValue(animation, out steps)) steps = Manifest.anims["idle"];
            var portrait = new CroppedBitmap(Frames[steps[0][0]], new Int32Rect(7, 5, 27, 30));
            portrait.Freeze();

            return portrait;
        }

        static Stream Resource(string name)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (stream == null) throw new InvalidOperationException("the exe was built without " + name);

            return stream;
        }

        static BitmapSource Picture(string name)
        {
            using (var stream = Resource(name))
            {
                var picture = new BitmapImage();
                picture.BeginInit();
                picture.StreamSource = stream;
                picture.CacheOption = BitmapCacheOption.OnLoad;
                picture.EndInit();
                picture.Freeze();

                return picture;
            }
        }

        static BitmapSource[] Cut(BitmapSource strip, int width, int height)
        {
            var parts = new BitmapSource[strip.PixelWidth / width];
            for (var i = 0; i < parts.Length; i++)
            {
                var part = new CroppedBitmap(strip, new Int32Rect(i * width, 0, width, height));
                part.Freeze();
                parts[i] = part;
            }

            return parts;
        }
    }

    public class Status
    {
        public string mood;
        public string prop;
        public string line;
        public long at;
        public int tools;
    }

    // One session waiting on you, from a file of its own in waiting/.
    public class Waiting
    {
        public bool isWaiting;
        public string project;
        public string question;
        public long since;
    }

    public class Settings
    {
        public double? left;
        public double? top;
        public double? center; // where Aster stands, whatever the window's width; replaces `left`
        public int scale = 3;
        public bool talk = true;
        public int pets;
        public int snacks;
        public bool dismissed;
    }

    public class PetWindow : Window
    {
        const double BubbleRoom = 58;
        // Mostly see-through and clicked through, wide enough for the bubble to slide
        // along when Aster sits at the very edge of the screen.
        const double SmallestWidth = 500;
        const int MinScale = 2;
        const int MaxScale = 8;
        const double DragThreshold = 4;
        static readonly TimeSpan NapAfter = TimeSpan.FromMinutes(5);
        static readonly TimeSpan ReactionLasts = TimeSpan.FromSeconds(4);
        static readonly TimeSpan WorkGoesStale = TimeSpan.FromMinutes(15);
        static readonly TimeSpan MadAfter = TimeSpan.FromMinutes(10);
        static readonly TimeSpan NagEvery = TimeSpan.FromSeconds(45);
        static readonly TimeSpan WaitingGivesUp = TimeSpan.FromHours(2);

        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_NOACTIVATE = 0x08000000;
        const int WS_EX_TOPMOST = 0x00000008;
        const uint GW_HWNDPREV = 3;
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOACTIVATE = 0x0010;
        static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        struct POINT { public int X; public int Y; }

        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint command);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly string folder;
        readonly string statusPath;
        readonly string settingsPath;
        readonly Settings settings;
        readonly Manifest manifest;
        readonly BitmapSource[] frames;
        readonly Image image = new Image();
        readonly Border bubble = new Border();
        readonly StackPanel bubbleBox = new StackPanel();
        readonly TextBlock bubbleText = new TextBlock();
        readonly DispatcherTimer frameTimer = new DispatcherTimer();
        readonly DispatcherTimer pollTimer = new DispatcherTimer();
        readonly DispatcherTimer bubbleTimer = new DispatcherTimer();
        readonly DispatcherTimer topTimer = new DispatcherTimer();
        readonly DateTime startedAt = DateTime.UtcNow;
        IntPtr handle;

        Status status = new Status { mood = "idle", prop = "laptop", line = "" };
        DateTime statusStamp = DateTime.MinValue;
        string playing;
        int frameAt;
        string reaction;
        DateTime reactionUntil = DateTime.MinValue;
        DateTime lastTouch = DateTime.UtcNow;
        DateTime lastNag = DateTime.MinValue;
        bool hasNagged;
        bool isBubbleStuck;
        string waitingLineSaid;
        List<Waiting> waiting = new List<Waiting>();
        readonly Dictionary<string, Waiting> waitingByFile = new Dictionary<string, Waiting>();

        bool isPressed;
        bool isHeld;
        POINT pressAt;
        double pressLeft;
        double pressTop;

        PetMenu menu;

        public readonly Art Art;
        public int Pets { get { return settings.pets; } }
        public int Snacks { get { return settings.snacks; } }
        public int Scale { get { return settings.scale; } }
        public int ToolCount { get { return status.tools; } set { status.tools = value; } }
        public List<Waiting> WaitingNow { get { return waiting; } set { waiting = value; } }
        public BitmapSource PortraitNow { get { return Art.Portrait(CurrentAnimation()); } }

        public bool Talk
        {
            get { return settings.talk; }
            set
            {
                settings.talk = value;
                SaveSettings();
                if (value)
                {
                    Say("I'll keep you posted!");
                }
                else
                {
                    isBubbleStuck = false;
                    bubbleBox.Visibility = Visibility.Hidden;
                }
            }
        }

        public string MoodLine
        {
            get
            {
                var name = CurrentAnimation();
                if (name.StartsWith("working") && !string.IsNullOrEmpty(status.line)) return status.line;
                switch (name)
                {
                    case "thinking": return "Thinking hard…";
                    case "asleep": return "Having a little nap";
                    case "happy": return "Just finished something!";
                    case "oops": return "Something went wrong";
                    case "waving": return "Saying hi";
                    case "asking": return "Claude needs you!";
                    case "mad": return "Furious. Go answer Claude!";
                    case "munching": return "Mid-snack";
                    case "loved": return "Feeling very loved";
                    default: return "Just hanging out";
                }
            }
        }

        public PetWindow(string folder, Settings settings, Art art)
        {
            this.folder = folder;
            this.settings = settings;
            Art = art;
            manifest = art.Manifest;
            frames = art.Frames;
            statusPath = System.IO.Path.Combine(folder, "status.json");
            settingsPath = System.IO.Path.Combine(folder, "settings.json");

            Title = "Aster";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            ResizeMode = ResizeMode.NoResize;
            SizeToContent = SizeToContent.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            Width = SmallestWidth;
            Height = BubbleRoom + manifest.h * settings.scale;

            BuildBubble();

            RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.NearestNeighbor);
            image.Stretch = Stretch.Fill;
            image.HorizontalAlignment = HorizontalAlignment.Center;
            image.VerticalAlignment = VerticalAlignment.Bottom;
            image.MouseLeftButtonDown += OnPress;
            image.MouseMove += OnDrag;
            image.MouseLeftButtonUp += OnRelease;
            image.LostMouseCapture += delegate { if (isPressed) LetGo(); };
            image.MouseRightButtonUp += delegate { ShowMenu(); };
            image.MouseWheel += OnWheel;

            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(BubbleRoom) });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            Grid.SetRow(bubbleBox, 0);
            Grid.SetRow(image, 1);
            root.Children.Add(bubbleBox);
            root.Children.Add(image);
            Content = root;

            frameTimer.Tick += delegate { NextFrame(); };
            pollTimer.Interval = TimeSpan.FromMilliseconds(300);
            pollTimer.Tick += delegate { Poll(); };
            bubbleTimer.Tick += delegate { bubbleTimer.Stop(); FadeBubble(); };
            topTimer.Interval = TimeSpan.FromSeconds(1);
            topTimer.Tick += delegate { StayOnTop(); };

            SourceInitialized += delegate
            {
                handle = new WindowInteropHelper(this).Handle;
                SetWindowLong(handle, GWL_EXSTYLE,
                    GetWindowLong(handle, GWL_EXSTYLE) | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
                ApplySize();
                PlaceAtStart();
            };
            Loaded += delegate
            {
                SaveSettings(); // being summoned clears "put away" for good, even if Aster is killed later
                React("waving", 2);
                Say("Hi! I'm Aster.");
                Poll();
                pollTimer.Start();
                SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                topTimer.Start();
            };
            Closed += delegate { SaveSettings(); };
        }

        // The always-on-top flag alone didn't hold: Aster was seen behind ordinary
        // windows with the flag still set. So look: an ordinary window above Aster
        // means it slipped. Other always-on-top windows are left alone, which keeps
        // Aster from fighting them or covering a menu that's open.
        void StayOnTop()
        {
            for (var above = GetWindow(handle, GW_HWNDPREV); above != IntPtr.Zero; above = GetWindow(above, GW_HWNDPREV))
            {
                if (IsWindowVisible(above) && (GetWindowLong(above, GWL_EXSTYLE) & WS_EX_TOPMOST) == 0)
                {
                    SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

                    return;
                }
            }
        }

        void BuildBubble()
        {
            var ink = new SolidColorBrush(Color.FromRgb(0x4a, 0x23, 0x18));
            var cream = new SolidColorBrush(Color.FromRgb(0xff, 0xf8, 0xf0));

            bubbleText.FontFamily = new FontFamily("Cascadia Mono, Consolas");
            bubbleText.FontSize = 13;
            bubbleText.FontWeight = FontWeights.SemiBold;
            bubbleText.Foreground = ink;
            bubbleText.TextWrapping = TextWrapping.Wrap;
            bubbleText.TextAlignment = TextAlignment.Center;
            bubbleText.MaxWidth = 220;

            bubble.Child = bubbleText;
            bubble.Background = cream;
            bubble.BorderBrush = ink;
            bubble.BorderThickness = new Thickness(2);
            bubble.CornerRadius = new CornerRadius(5);
            bubble.Padding = new Thickness(8, 4, 8, 4);
            bubble.HorizontalAlignment = HorizontalAlignment.Center;

            var tail = new Polygon
            {
                Fill = cream,
                Stroke = ink,
                StrokeThickness = 2,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, -2, 0, 0),
                Points = new PointCollection(new[] { new Point(0, 0), new Point(12, 0), new Point(6, 7) }),
            };

            bubbleBox.VerticalAlignment = VerticalAlignment.Bottom;
            bubbleBox.Visibility = Visibility.Hidden;
            bubbleBox.IsHitTestVisible = false;
            bubbleBox.Children.Add(bubble);
            bubbleBox.Children.Add(tail);
        }

        double DevicePixelsPerDip()
        {
            var source = PresentationSource.FromVisual(this);

            return source != null && source.CompositionTarget != null
                ? source.CompositionTarget.TransformToDevice.M11
                : 1;
        }

        // Whole device pixels to a sprite pixel, so the art stays crisp at any DPI.
        void ApplySize()
        {
            var dpi = DevicePixelsPerDip();
            var perPixel = Math.Max(1, Math.Round(settings.scale * dpi));
            image.Width = manifest.w * perPixel / dpi;
            image.Height = manifest.h * perPixel / dpi;
            var center = Left + Width / 2;
            var bottom = Top + Height;
            Width = Math.Max(image.Width, SmallestWidth);
            Height = BubbleRoom + image.Height;
            if (!double.IsNaN(center) && !double.IsNaN(bottom))
            {
                Left = center - Width / 2;
                Top = bottom - Height;
            }
        }

        void PlaceAtStart()
        {
            const double OldWindowWidth = 250;
            var center = settings.center;
            if (!center.HasValue && settings.left.HasValue) center = settings.left.Value + OldWindowWidth / 2;
            if (center.HasValue && settings.top.HasValue)
            {
                Left = center.Value - Width / 2;
                Top = settings.top.Value;
                KeepOnScreen();

                return;
            }

            var area = SystemParameters.WorkArea;
            Left = area.Right - Width / 2 - image.Width / 2 - 24;
            Top = area.Bottom - Height;
        }

        // Anywhere is fine, as long as the pet itself can't be lost off the edge.
        void KeepOnScreen()
        {
            var left = SystemParameters.VirtualScreenLeft;
            var top = SystemParameters.VirtualScreenTop;
            var right = left + SystemParameters.VirtualScreenWidth;
            var bottom = top + SystemParameters.VirtualScreenHeight;
            Left = Math.Max(left - Width / 2 + 30, Math.Min(Left, right - Width / 2 - 30));
            Top = Math.Max(top - BubbleRoom, Math.Min(Top, bottom - Height));
        }

        // --- What Aster shows ---------------------------------------------------

        string CurrentAnimation()
        {
            var now = DateTime.UtcNow;
            if (isHeld) return "held";
            if (reaction != null && now < reactionUntil) return reaction;
            reaction = null;

            // Claude waiting on you beats anything another session is up to: asking
            // at first, mad once the longest wait passes ten minutes.
            if (waiting.Count > 0) return now - FromEpoch(waiting[0].since) > MadAfter ? "mad" : "asking";

            var since = status.at > 0 ? FromEpoch(status.at) : startedAt;
            var age = now - since;
            var mood = status.mood ?? "idle";

            if ((mood == "happy" || mood == "oops") && age > ReactionLasts) mood = "idle";
            if ((mood == "thinking" || mood == "working" || mood == "waving") && age > WorkGoesStale) mood = "idle";

            if (mood == "asking") mood = "idle"; // waiting is told by waiting/ now, never by the status
            if (mood == "idle")
            {
                var quiet = now - Later(Later(since, startedAt), lastTouch);

                return quiet > NapAfter ? "asleep" : "idle";
            }
            if (mood == "working")
            {
                var name = "working-" + (status.prop ?? "laptop");

                return manifest.anims.ContainsKey(name) ? name : "working-laptop";
            }

            return manifest.anims.ContainsKey(mood) ? mood : "idle";
        }

        static DateTime Later(DateTime a, DateTime b) { return a > b ? a : b; }

        static DateTime FromEpoch(long ms)
        {
            return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms);
        }

        void Refresh()
        {
            var name = CurrentAnimation();
            if (name != playing)
            {
                playing = name;
                frameAt = -1;
                SayMood(name);
                NextFrame();
            }
            if (name == "asking" && WaitingLine() != waitingLineSaid) SayMood(name);
            if (name == "mad" && DateTime.UtcNow - lastNag > NagEvery) Nag();
        }

        string WaitingLine()
        {
            return waiting.Count == 1
                ? "Claude needs you in " + waiting[0].project + "!"
                : "Claude needs you in " + waiting.Count + " places!";
        }

        // What Aster says about Claude waiting stays up until it's answered.
        void SayMood(string name)
        {
            if (name == "asking")
            {
                waitingLineSaid = WaitingLine();
                Say(waitingLineSaid, true);
            }
            else if (name == "mad")
            {
                Nag();
            }
            else if (reaction == null)
            {
                hasNagged = false;
                if (isBubbleStuck)
                {
                    isBubbleStuck = false;
                    FadeBubble();
                }
            }
        }

        void Nag()
        {
            lastNag = DateTime.UtcNow;
            Say(hasNagged
                ? Pick("HELLO?? Claude needs you!", "Right-click me. I'll show you where.", "Still waiting over here...", "I'm not mad. Okay, I'm mad.", "Answer Claude already!", "Rude.", "Claude is being very patient. I am not.")
                : "Hey! Claude's been waiting 10 minutes!", true);
            hasNagged = true;
        }

        void NextFrame()
        {
            int[][] steps;
            if (playing == null || !manifest.anims.TryGetValue(playing, out steps)) return;
            frameAt = (frameAt + 1) % steps.Length;
            image.Source = frames[steps[frameAt][0]];
            frameTimer.Stop();
            frameTimer.Interval = TimeSpan.FromMilliseconds(steps[frameAt][1]);
            frameTimer.Start();
            if (frameAt == steps.Length - 1) Refresh();
        }

        void React(string name, int loops)
        {
            var total = 0;
            foreach (var step in manifest.anims[name]) total += step[1];
            reaction = name;
            reactionUntil = DateTime.UtcNow.AddMilliseconds(total * loops);
            playing = null;
            Refresh();
        }

        void Say(string line, bool isStuck = false)
        {
            if (!settings.talk || string.IsNullOrEmpty(line)) return;
            bubbleText.Text = line;
            bubbleBox.BeginAnimation(OpacityProperty, null);
            bubbleBox.Opacity = 1;
            bubbleBox.Visibility = Visibility.Visible;
            isBubbleStuck = isStuck;
            PlaceBubble();
            bubbleTimer.Stop();
            if (isStuck) return;
            bubbleTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(2600, line.Length * 90));
            bubbleTimer.Start();
        }

        // Aster can sit right at the edge of the screen, so the bubble slides along
        // to stay readable. The tail stays over Aster.
        void PlaceBubble()
        {
            if (bubbleBox.Visibility != Visibility.Visible) return;
            bubbleBox.UpdateLayout();
            const double Gap = 6;
            var center = Left + Width / 2;
            var half = bubble.ActualWidth / 2;
            var screenLeft = SystemParameters.VirtualScreenLeft;
            var screenRight = screenLeft + SystemParameters.VirtualScreenWidth;
            var shift = 0.0;
            if (center + half > screenRight - Gap) shift = screenRight - Gap - (center + half);
            else if (center - half < screenLeft + Gap) shift = screenLeft + Gap - (center - half);
            bubble.RenderTransform = new TranslateTransform(shift, 0);
        }

        void FadeBubble()
        {
            var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(350));
            fade.Completed += delegate
            {
                if (!bubbleTimer.IsEnabled && !isBubbleStuck) bubbleBox.Visibility = Visibility.Hidden;
            };
            bubbleBox.BeginAnimation(OpacityProperty, fade);
        }

        // Every session waiting on you has a file saying so. Files it's done with, and
        // waits from a session that died without saying so, are cleared here.
        void ReadWaiting()
        {
            var found = new List<Waiting>();
            var directory = System.IO.Path.Combine(folder, "waiting");
            if (Directory.Exists(directory))
            {
                foreach (var file in Directory.GetFiles(directory, "*.json"))
                {
                    try
                    {
                        var entry = json.Deserialize<Waiting>(ReadShared(file));
                        if (entry == null) continue;
                        if (!entry.isWaiting || DateTime.UtcNow - FromEpoch(entry.since) > WaitingGivesUp)
                        {
                            waitingByFile.Remove(file);
                            File.Delete(file);
                            continue;
                        }
                        waitingByFile[file] = entry;
                        found.Add(entry);
                    }
                    catch (Exception)
                    {
                        // Half-written: keep what it said last, and read it again next poll.
                        Waiting known;
                        if (waitingByFile.TryGetValue(file, out known)) found.Add(known);
                    }
                }
            }
            found.Sort((a, b) => a.since.CompareTo(b.since));
            waiting = found;
        }

        static string ReadShared(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        void Poll()
        {
            try
            {
                ReadWaiting();
            }
            catch (Exception)
            {
                // Next poll tries again.
            }
            try
            {
                if (File.Exists(statusPath))
                {
                    var stamp = File.GetLastWriteTimeUtc(statusPath);
                    if (stamp != statusStamp)
                    {
                        // Read alongside the plugin's writes; a half-written file fails
                        // the parse and is simply read again on the next poll.
                        var next = json.Deserialize<Status>(ReadShared(statusPath));
                        if (next != null)
                        {
                            statusStamp = stamp;
                            var previous = status.line;
                            var isFresh = status.at != next.at;
                            status = next;
                            if (isFresh && next.line != previous && waiting.Count == 0) Say(next.line);
                        }
                    }
                }
            }
            catch (Exception)
            {
                // Next poll tries again.
            }
            Refresh();
        }

        // --- What you can do to Aster --------------------------------------------

        void OnPress(object sender, MouseButtonEventArgs e)
        {
            if (e.ClickCount == 2)
            {
                GiveSnack();
                e.Handled = true;

                return;
            }
            GetCursorPos(out pressAt);
            pressLeft = Left;
            pressTop = Top;
            isPressed = true;
            isHeld = false;
            image.CaptureMouse();
            e.Handled = true;
        }

        void OnDrag(object sender, MouseEventArgs e)
        {
            if (!isPressed) return;
            POINT now;
            GetCursorPos(out now);
            var dpi = DevicePixelsPerDip();
            var dx = (now.X - pressAt.X) / dpi;
            var dy = (now.Y - pressAt.Y) / dpi;
            if (!isHeld && Math.Abs(dx) < DragThreshold && Math.Abs(dy) < DragThreshold) return;
            if (!isHeld)
            {
                isHeld = true;
                Say(Pick("Wheee!", "Whoa!", "Where are we going?", "Up we go!"));
                Refresh();
            }
            Left = pressLeft + dx;
            Top = pressTop + dy;
            PlaceBubble();
        }

        void OnRelease(object sender, MouseButtonEventArgs e)
        {
            if (!isPressed) return;
            var wasHeld = isHeld;
            LetGo();
            image.ReleaseMouseCapture();
            if (!wasHeld) Pet();
            e.Handled = true;
        }

        // A release, or losing the mouse mid-drag: either way Aster lands.
        void LetGo()
        {
            var wasHeld = isHeld;
            isPressed = false;
            isHeld = false;
            lastTouch = DateTime.UtcNow;
            if (!wasHeld) return;
            KeepOnScreen();
            RememberPlace();
            SaveSettings();
            React("land", 1);
        }

        public void Pet()
        {
            settings.pets++;
            lastTouch = DateTime.UtcNow;
            SaveSettings();
            if (playing == "mad")
            {
                lastNag = DateTime.UtcNow;
                Say("Don't pet me. Go answer Claude!", true);

                return;
            }
            React("loved", 2);
            Say(Pick("Aww, thank you!", "Hehe, that tickles!", "More please!", "You're the best."));
        }

        public void GiveSnack()
        {
            settings.snacks++;
            lastTouch = DateTime.UtcNow;
            SaveSettings();
            var wasMad = playing == "mad";
            React("munching", 1);
            Say(wasMad ? "Hmph. Fine. One cookie." : Pick("Nom nom nom.", "Cookie!!", "So crunchy."));
        }

        void OnWheel(object sender, MouseWheelEventArgs e)
        {
            SetScale(settings.scale + (e.Delta > 0 ? 1 : -1));
            e.Handled = true;
        }

        public void SetScale(int scale)
        {
            settings.scale = Math.Max(MinScale, Math.Min(MaxScale, scale));
            ApplySize();
            KeepOnScreen();
            RememberPlace();
            SaveSettings();
        }

        void RememberPlace()
        {
            settings.center = Left + Width / 2;
            settings.left = null;
            settings.top = Top;
        }

        void ShowMenu()
        {
            if (menu != null) menu.CloseNow();
            menu = new PetMenu(this, DevicePixelsPerDip());
            menu.Closed += delegate { menu = null; };
            menu.OpenAtCursor();
        }

        // Stays away until /aster brings it back: the plugin starts it with no flag,
        // and a dismissed Aster started that way leaves at once.
        public void PutAway()
        {
            settings.dismissed = true;
            Close();
        }

        static readonly Random random = new Random();

        static string Pick(params string[] lines) { return lines[random.Next(lines.Length)]; }

        void SaveSettings()
        {
            try
            {
                var temporary = settingsPath + ".tmp";
                File.WriteAllText(temporary, json.Serialize(settings));
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
                File.Move(temporary, settingsPath);
            }
            catch (Exception ex)
            {
                Program.Log(folder, "could not save settings: " + ex.Message);
            }
        }
    }

    public static class Program
    {
        static Mutex single;

        public static void Log(string folder, string line)
        {
            try
            {
                File.AppendAllText(System.IO.Path.Combine(folder, "aster.log"),
                    DateTime.Now.ToString("s") + " " + line + Environment.NewLine);
            }
            catch (Exception)
            {
                // Nowhere left to say it.
            }
        }

        [STAThread]
        public static int Main(string[] args)
        {
            var folder = AppDomain.CurrentDomain.BaseDirectory;

            var renderAt = Array.IndexOf(args, "--render-menu");
            if (renderAt >= 0 && renderAt + 1 < args.Length)
            {
                var sample = new PetWindow(folder, new Settings { pets = 42, snacks = 12 }, Art.Load()) { ToolCount = 128 };
                var now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                sample.WaitingNow = new List<Waiting>
                {
                    new Waiting { project = "my-website", question = "Okay to delete the old build folder?", since = now - 4 * 60000 },
                    new Waiting { project = "aster-pet", question = "Send this update to GitHub too?", since = now - 30000 },
                };
                PetMenu.RenderToPng(sample, args[renderAt + 1]);

                return 0;
            }

            bool isFirst;
            single = new Mutex(true, "Local\\AsterClaudeDesktopPet", out isFirst);
            if (!isFirst) return 0;

            try
            {
                var json = new JavaScriptSerializer();
                var settingsPath = System.IO.Path.Combine(folder, "settings.json");
                var settings = new Settings();
                if (File.Exists(settingsPath))
                {
                    try { settings = json.Deserialize<Settings>(File.ReadAllText(settingsPath)) ?? settings; }
                    catch (Exception ex) { Log(folder, "starting from default settings: " + ex.Message); }
                }

                var isSummoned = Array.IndexOf(args, "--summon") >= 0;
                if (settings.dismissed && !isSummoned) return 0;
                settings.dismissed = false;

                var app = new Application();
                app.ShutdownMode = ShutdownMode.OnMainWindowClose;
                app.DispatcherUnhandledException += (sender, e) =>
                {
                    Log(folder, "error: " + e.Exception);
                    e.Handled = true;
                };

                return app.Run(new PetWindow(folder, settings, Art.Load()));
            }
            catch (Exception ex)
            {
                Log(folder, "could not start: " + ex);

                return 1;
            }
        }
    }
}
