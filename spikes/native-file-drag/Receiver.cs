using System;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using System.Drawing;

internal static class Receiver {
    [STAThread]
    static void Main(string[] args) {
        string root = Path.GetFullPath(args[0]);
        if (!root.Contains("\\native-file-drag\\")) throw new ArgumentException("isolated evidence root required");
        Application.EnableVisualStyles();
        var form = new Form { Text = "Synthetic External File Receiver", StartPosition = FormStartPosition.Manual, Location = new Point(420, 475), Size = new Size(480, 240), AllowDrop = true, TopMost = true };
        var label = new Label { Dock = DockStyle.Fill, Text = "Local test receiver\nNo upload, no source copying", Font = new Font("Segoe UI", 16), TextAlign = ContentAlignment.MiddleCenter, AllowDrop = true };
        form.Controls.Add(label);
        DragEventHandler offer = (sender, e) => { if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
        form.DragEnter += offer;
        form.DragOver += offer;
        label.DragEnter += offer;
        label.DragOver += offer;
        DragEventHandler receive = (sender, e) => {
            var paths = (string[])e.Data.GetData(DataFormats.FileDrop);
            label.Text = "Received original file paths:\n" + string.Join("\n", paths);
            File.AppendAllLines(Path.Combine(root, "receiver.txt"), paths.Concat(new[] { "END" }));
        };
        form.DragDrop += receive;
        label.DragDrop += receive;
        Application.Run(form);
    }
}
