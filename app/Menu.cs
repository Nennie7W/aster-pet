// The right-click menu: a little card of its own, in Aster's colors, with Aster's
// pixel icons. A window rather than a ContextMenu, because Aster's window never
// takes focus and a ContextMenu is drawn by Windows' stock template.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Aster
{
    public class PetMenu : Window
    {
        const double ShadowRoom = 16;
        const double CardWidth = 258;
        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const uint MONITOR_DEFAULTTONEAREST = 2;
        const int VK_LBUTTON = 0x01;
        const int VK_RBUTTON = 0x02;

        static readonly Brush Ink = Solid(0x4a, 0x23, 0x18);
        static readonly Brush Cream = Solid(0xff, 0xf8, 0xf0);
        static readonly Brush Terracotta = Solid(0xd9, 0x77, 0x57);
        static readonly Brush Soft = Solid(0xf8, 0xe8, 0xda);
        static readonly Brush Line = Solid(0xe6, 0xcf, 0xbd);
        static readonly Brush Faint = Solid(0x8f, 0x6d, 0x5e);
        static readonly FontFamily Face = new FontFamily("Cascadia Mono, Consolas");

        struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int index, int value);

        readonly PetWindow pet;
        readonly double dpi;
        readonly DispatcherTimer watch = new DispatcherTimer();
        readonly List<Tuple<Border, TextBlock, int>> sizePills = new List<Tuple<Border, TextBlock, int>>();
        readonly TranslateTransform slide = new TranslateTransform();
        Border switchTrack;
        Border switchKnob;
        bool isClosing;

        public PetMenu(PetWindow pet, double dpi)
        {
            this.pet = pet;
            this.dpi = dpi;

            Title = "Aster menu";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            SizeToContent = SizeToContent.WidthAndHeight;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            Content = BuildCard();

            SourceInitialized += delegate
            {
                var handle = new WindowInteropHelper(this).Handle;
                SetWindowLong(handle, GWL_EXSTYLE, GetWindowLong(handle, GWL_EXSTYLE) | WS_EX_TOOLWINDOW);
            };
            Deactivated += delegate { CloseNow(); };
            PreviewKeyDown += (sender, e) => { if (e.Key == Key.Escape) CloseNow(); };

            // Windows can refuse a background app focus, and then Deactivated never
            // comes, so a click anywhere else closes the menu too.
            watch.Interval = TimeSpan.FromMilliseconds(80);
            watch.Tick += delegate { CloseOnClickElsewhere(); };
        }

        public void OpenAtCursor()
        {
            POINT cursor;
            GetCursorPos(out cursor);

            var root = (FrameworkElement)Content;
            root.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var width = root.DesiredSize.Width;
            var height = root.DesiredSize.Height;

            var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            GetMonitorInfo(MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST), ref info);

            var x = cursor.X / dpi - ShadowRoom;
            var y = cursor.Y / dpi - ShadowRoom;
            if (x + width > info.rcWork.Right / dpi) x = cursor.X / dpi - width + ShadowRoom;
            if (y + height > info.rcWork.Bottom / dpi) y = cursor.Y / dpi - height + ShadowRoom;
            Left = Math.Max(x, info.rcWork.Left / dpi - ShadowRoom);
            Top = Math.Max(y, info.rcWork.Top / dpi - ShadowRoom);

            root.Opacity = 0;
            Show();
            Activate();
            watch.Start();

            var soon = new Duration(TimeSpan.FromMilliseconds(130));
            root.BeginAnimation(OpacityProperty, new DoubleAnimation(1, soon));
            slide.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(5, 0, soon)
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            });
        }

        public void CloseNow()
        {
            if (isClosing) return;
            isClosing = true;
            watch.Stop();
            Dispatcher.BeginInvoke(new Action(Close));
        }

        void CloseOnClickElsewhere()
        {
            var isPressed = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0 || (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
            if (!isPressed) return;
            POINT cursor;
            GetCursorPos(out cursor);
            var x = cursor.X / dpi;
            var y = cursor.Y / dpi;
            var isInside = x >= Left && x <= Left + ActualWidth && y >= Top && y <= Top + ActualHeight;
            if (!isInside) CloseNow();
        }

        // --- The card -----------------------------------------------------------

        FrameworkElement BuildCard()
        {
            var list = new StackPanel();
            list.Children.Add(Header());
            list.Children.Add(Stats());
            list.Children.Add(Divider());
            list.Children.Add(ActionRow("heart", "Pet Aster", "click", pet.Pet));
            list.Children.Add(ActionRow("cookie", "Give a snack", "double-click", pet.GiveSnack));
            list.Children.Add(Divider());
            list.Children.Add(SizeRow());
            list.Children.Add(TalkRow());
            list.Children.Add(Divider());
            list.Children.Add(ActionRow("moon", "Put Aster away", "/aster", pet.PutAway));

            // The shadow is on a backing of its own: an effect on the card would
            // blur all the text in it.
            var backing = new Border
            {
                Background = Cream,
                CornerRadius = new CornerRadius(11),
                Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 4, Direction = 270, Opacity = 0.32, Color = Colors.Black },
            };
            var card = new Border
            {
                BorderBrush = Ink,
                BorderThickness = new Thickness(2),
                CornerRadius = new CornerRadius(11),
                Padding = new Thickness(7),
                Child = list,
            };
            var root = new Grid { Width = CardWidth + ShadowRoom * 2, Margin = new Thickness(0), RenderTransform = slide };
            backing.Margin = new Thickness(ShadowRoom);
            card.Margin = new Thickness(ShadowRoom);
            root.Children.Add(backing);
            root.Children.Add(card);

            return root;
        }

        FrameworkElement Header()
        {
            var name = Words("Aster", 15, Ink, true);
            var mood = Words(pet.MoodLine, 11.5, Faint, false);
            mood.TextTrimming = TextTrimming.CharacterEllipsis;
            mood.Margin = new Thickness(0, 1, 0, 0);

            var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) };
            names.Children.Add(name);
            names.Children.Add(mood);

            var portrait = Pixels(pet.Art.Portrait, 2);
            DockPanel.SetDock(portrait, Dock.Left);
            var header = new DockPanel { Margin = new Thickness(5, 3, 5, 6) };
            header.Children.Add(portrait);
            header.Children.Add(names);

            return header;
        }

        FrameworkElement Stats()
        {
            var grid = new UniformGrid { Columns = 3, Margin = new Thickness(1, 0, 1, 1) };
            grid.Children.Add(Stat("heart", pet.Pets, "pets"));
            grid.Children.Add(Stat("cookie", pet.Snacks, "snacks"));
            grid.Children.Add(Stat("spark", pet.ToolCount, "tools"));

            return grid;
        }

        FrameworkElement Stat(string icon, int count, string label)
        {
            var top = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
            top.Children.Add(PixelIcon(icon));
            var number = Words(count.ToString("N0"), 13, Ink, true);
            number.Margin = new Thickness(4, 0, 0, 0);
            number.VerticalAlignment = VerticalAlignment.Center;
            top.Children.Add(number);

            var under = Words(label, 10.5, Faint, false);
            under.HorizontalAlignment = HorizontalAlignment.Center;

            var stack = new StackPanel();
            stack.Children.Add(top);
            stack.Children.Add(under);

            return new Border
            {
                Background = Soft,
                CornerRadius = new CornerRadius(7),
                Margin = new Thickness(2),
                Padding = new Thickness(2, 5, 2, 4),
                Child = stack,
            };
        }

        FrameworkElement Divider()
        {
            return new Border { Height = 1, Background = Line, Margin = new Thickness(6, 6, 6, 6) };
        }

        Border RowShell(FrameworkElement child)
        {
            return new Border
            {
                CornerRadius = new CornerRadius(7),
                Padding = new Thickness(7, 6, 8, 6),
                Background = Brushes.Transparent,
                Cursor = Cursors.Hand,
                Child = child,
            };
        }

        DockPanel RowContent(string icon, TextBlock label)
        {
            var mark = PixelIcon(icon);
            mark.Margin = new Thickness(0, 0, 9, 0);
            DockPanel.SetDock(mark, Dock.Left);
            var dock = new DockPanel { LastChildFill = true };
            dock.Children.Add(mark);
            label.VerticalAlignment = VerticalAlignment.Center;

            return dock;
        }

        // A row that does its thing and closes the menu.
        FrameworkElement ActionRow(string icon, string text, string hint, Action action)
        {
            var label = Words(text, 13, Ink, false);
            var aside = Words(hint, 10.5, Faint, false);
            aside.VerticalAlignment = VerticalAlignment.Center;
            DockPanel.SetDock(aside, Dock.Right);

            var dock = RowContent(icon, label);
            dock.Children.Add(aside);
            dock.Children.Add(label);

            var row = RowShell(dock);
            row.MouseEnter += delegate
            {
                row.Background = Terracotta;
                label.Foreground = Cream;
                aside.Foreground = Cream;
            };
            row.MouseLeave += delegate
            {
                row.Background = Brushes.Transparent;
                label.Foreground = Ink;
                aside.Foreground = Faint;
            };
            row.MouseLeftButtonUp += delegate
            {
                CloseNow();
                action();
            };

            return row;
        }

        // Size stays open, so you can watch Aster grow and pick again.
        FrameworkElement SizeRow()
        {
            var label = Words("Size", 13, Ink, false);
            var pills = new StackPanel { Orientation = Orientation.Horizontal };
            DockPanel.SetDock(pills, Dock.Right);
            foreach (var option in new[] { Tuple.Create("S", 2), Tuple.Create("M", 3), Tuple.Create("L", 4), Tuple.Create("XL", 6) })
            {
                var scale = option.Item2;
                var text = Words(option.Item1, 11.5, Ink, true);
                text.HorizontalAlignment = HorizontalAlignment.Center;
                text.VerticalAlignment = VerticalAlignment.Center;
                var pill = new Border
                {
                    Width = 28,
                    Height = 22,
                    CornerRadius = new CornerRadius(6),
                    Margin = new Thickness(3, 0, 0, 0),
                    Cursor = Cursors.Hand,
                    Child = text,
                };
                pill.MouseEnter += delegate { if (pet.Scale != scale) pill.Background = Line; };
                pill.MouseLeave += delegate { PaintPills(); };
                pill.MouseLeftButtonUp += delegate
                {
                    pet.SetScale(scale);
                    PaintPills();
                };
                sizePills.Add(Tuple.Create(pill, text, scale));
                pills.Children.Add(pill);
            }
            PaintPills();

            var dock = RowContent("size", label);
            dock.Children.Add(pills);
            dock.Children.Add(label);

            var row = RowShell(dock);
            row.Cursor = Cursors.Arrow;
            row.Padding = new Thickness(7, 3, 6, 3);

            return row;
        }

        void PaintPills()
        {
            foreach (var pill in sizePills)
            {
                var isChosen = pet.Scale == pill.Item3;
                pill.Item1.Background = isChosen ? Terracotta : Soft;
                pill.Item2.Foreground = isChosen ? Cream : Ink;
            }
        }

        // The bubble's switch stays open too, so the switch can be seen to flip.
        FrameworkElement TalkRow()
        {
            var label = Words("Speech bubble", 13, Ink, false);
            switchKnob = new Border
            {
                Width = 14,
                Height = 14,
                CornerRadius = new CornerRadius(7),
                Background = Cream,
                Margin = new Thickness(2, 0, 2, 0),
                VerticalAlignment = VerticalAlignment.Center,
            };
            switchTrack = new Border
            {
                Width = 34,
                Height = 18,
                CornerRadius = new CornerRadius(9),
                VerticalAlignment = VerticalAlignment.Center,
                Child = switchKnob,
            };
            DockPanel.SetDock(switchTrack, Dock.Right);
            PaintSwitch();

            var dock = RowContent("bubble", label);
            dock.Children.Add(switchTrack);
            dock.Children.Add(label);

            var row = RowShell(dock);
            row.MouseEnter += delegate { row.Background = Soft; };
            row.MouseLeave += delegate { row.Background = Brushes.Transparent; };
            row.MouseLeftButtonUp += delegate
            {
                pet.Talk = !pet.Talk;
                PaintSwitch();
            };

            return row;
        }

        void PaintSwitch()
        {
            switchTrack.Background = pet.Talk ? Terracotta : Line;
            switchKnob.HorizontalAlignment = pet.Talk ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        }

        // --- Small parts --------------------------------------------------------

        static TextBlock Words(string text, double size, Brush color, bool isBold)
        {
            return new TextBlock
            {
                Text = text,
                FontFamily = Face,
                FontSize = size,
                FontWeight = isBold ? FontWeights.Bold : FontWeights.Normal,
                Foreground = color,
            };
        }

        Image PixelIcon(string name)
        {
            return Pixels(pet.Art.Icon(name), 1.6);
        }

        // Whole device pixels to a sprite pixel, the same way Aster is drawn.
        Image Pixels(BitmapSource source, double scale)
        {
            var perPixel = Math.Max(1, Math.Round(scale * dpi));
            var image = new Image
            {
                Source = source,
                Stretch = Stretch.Fill,
                Width = source.PixelWidth * perPixel / dpi,
                Height = source.PixelHeight * perPixel / dpi,
                SnapsToDevicePixels = true,
                VerticalAlignment = VerticalAlignment.Center,
            };
            RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.NearestNeighbor);

            return image;
        }

        static Brush Solid(byte r, byte g, byte b)
        {
            var brush = new SolidColorBrush(Color.FromRgb(r, g, b));
            brush.Freeze();

            return brush;
        }

        // Draws the menu to a picture with no window, for the README and for looking
        // at it without having to right-click: Aster.exe --render-menu out.png
        public static void RenderToPng(PetWindow pet, string path)
        {
            const double Scale = 2;
            var menu = new PetMenu(pet, Scale);
            var root = (FrameworkElement)menu.Content;
            menu.Content = null;
            root.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            root.Arrange(new Rect(root.DesiredSize));
            root.UpdateLayout();

            var picture = new RenderTargetBitmap(
                (int)Math.Ceiling(root.ActualWidth * Scale),
                (int)Math.Ceiling(root.ActualHeight * Scale),
                96 * Scale,
                96 * Scale,
                PixelFormats.Pbgra32);
            picture.Render(root);

            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(picture));
            using (var file = File.Create(path)) encoder.Save(file);
        }
    }
}
