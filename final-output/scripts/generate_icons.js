const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// We can invoke PowerShell from a dedicated script file to avoid escaping issues
const psScript = `
Add-Type -AssemblyName System.Drawing

function Generate-Icon([int]$size, [string]$path, [bool]$isRound) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    
    if ($isRound) {
        $g.Clear([System.Drawing.Color]::Transparent)
        $brushBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
        $g.FillEllipse($brushBg, 0, 0, $size, $size)
        $brushBg.Dispose()
    } else {
        $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
    }
    
    $fontSize = [float]($size * 0.58)
    $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brushText = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    
    $rect = New-Object System.Drawing.RectangleF(0, -($size * 0.04), $size, $size)
    $g.DrawString('h', $font, $brushText, $rect, $format)
    
    $font.Dispose()
    $brushText.Dispose()
    $format.Dispose()
    $g.Dispose()
    
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Generated: $path ($size x $size)"
}

$densities = @{
    'mipmap-mdpi' = 48
    'mipmap-hdpi' = 72
    'mipmap-xhdpi' = 96
    'mipmap-xxhdpi' = 144
    'mipmap-xxxhdpi' = 192
}

$baseRes = 'E:\\APPP\\final-output\\android\\app\\src\\main\\res'

foreach ($d in $densities.Keys) {
    $s = $densities[$d]
    $dir = Join-Path $baseRes $d
    Generate-Icon $s (Join-Path $dir 'ic_launcher.png') $false
    Generate-Icon $s (Join-Path $dir 'ic_launcher_round.png') $true
}

$fgSizes = @{
    'mipmap-mdpi' = 108
    'mipmap-hdpi' = 162
    'mipmap-xhdpi' = 216
    'mipmap-xxhdpi' = 324
    'mipmap-xxxhdpi' = 432
}

foreach ($d in $fgSizes.Keys) {
    $s = $fgSizes[$d]
    $dir = Join-Path $baseRes $d
    # For adaptive foreground, background should be transparent, centered 'h'
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)
    
    $fontSize = [float]($s * 0.44)
    $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brushText = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    
    $rect = New-Object System.Drawing.RectangleF(0, -($s * 0.03), $s, $s)
    $g.DrawString('h', $font, $brushText, $rect, $format)
    
    $font.Dispose()
    $brushText.Dispose()
    $format.Dispose()
    $g.Dispose()
    
    $outPath = Join-Path $dir 'ic_launcher_foreground.png'
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Generated Foreground: $outPath ($s x $s)"
}
`;

fs.writeFileSync('generate_icons.ps1', psScript, 'utf8');
console.log('Saved generate_icons.ps1');
