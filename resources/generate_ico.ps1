Add-Type -AssemblyName System.Drawing

$srcPath = "c:\Users\user\Desktop\Projects\document-merger\resources\icon.jpg"
$pngPath = "c:\Users\user\Desktop\Projects\document-merger\resources\icon.png"
$icoPath = "c:\Users\user\Desktop\Projects\document-merger\resources\icon.ico"

# Load source image and resize to 256x256
$orig = [System.Drawing.Bitmap]::FromFile($srcPath)
$resized = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($resized)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($orig, 0, 0, 256, 256)
$g.Dispose()
$orig.Dispose()

# Save PNG
$resized.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Convert PNG stream to ICO format
$ms = New-Object System.IO.MemoryStream
$resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$ms.Dispose()
$resized.Dispose()

$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR
$bw.Write([uint16]0) # Reserved
$bw.Write([uint16]1) # Type 1 = Icon
$bw.Write([uint16]1) # 1 image

# ICONDIRENTRY (256x256 represented as 0, 0)
$bw.Write([byte]0)   # Width: 0 means 256
$bw.Write([byte]0)   # Height: 0 means 256
$bw.Write([byte]0)   # Color count: 0 (no palette)
$bw.Write([byte]0)   # Reserved
$bw.Write([uint16]1) # Color planes
$bw.Write([uint16]32)# Bits per pixel
$bw.Write([uint32]$pngBytes.Length) # Image size
$bw.Write([uint32]22) # Image offset (6 + 16 = 22)

# Write PNG payload
$bw.Write($pngBytes)
$bw.Flush()
$bw.Close()
$fs.Close()

Write-Output "Generated icon.png and icon.ico successfully"
