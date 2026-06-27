param(
  [int]$Port = 4173,
  [int]$PortAttempts = 20
)

$Root = (Get-Location).Path
$Address = [System.Net.IPAddress]::Parse("127.0.0.1")
$Server = $null
$ActualPort = $Port

for ($Attempt = 0; $Attempt -lt $PortAttempts; $Attempt += 1) {
  $CandidatePort = $Port + $Attempt
  try {
    $Server = [System.Net.Sockets.TcpListener]::new($Address, $CandidatePort)
    $Server.Start()
    $ActualPort = $CandidatePort
    break
  } catch {
    $Server = $null
    if ($Attempt -eq ($PortAttempts - 1)) {
      Write-Error "Could not start local server. Ports $Port-$($Port + $PortAttempts - 1) may be in use."
      Write-Error $_
      exit 1
    }
  }
}

if ($null -eq $Server) {
  Write-Error "Could not start local server."
  exit 1
}

if ($ActualPort -ne $Port) {
  Write-Host "Port $Port is busy. Using port $ActualPort instead."
}
Write-Host "Serving $Root at http://127.0.0.1:$ActualPort/"

function Get-ContentType($Path) {
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "text/javascript; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    ".png" { "image/png" }
    ".svg" { "image/svg+xml" }
    default { "application/octet-stream" }
  }
}

function Send-Response($Stream, [int]$Status, [string]$StatusText, [byte[]]$Body, [string]$ContentType) {
  $Header = "HTTP/1.1 $Status $StatusText`r`nContent-Length: $($Body.Length)`r`nContent-Type: $ContentType`r`nConnection: close`r`n`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
}

try {
  while ($Server.Server.IsBound) {
    $Client = $null
    try {
      $Client = $Server.AcceptTcpClient()
      if ($null -eq $Client) {
        continue
      }
      $Stream = $Client.GetStream()
      $Buffer = New-Object byte[] 8192
      $Read = $Stream.Read($Buffer, 0, $Buffer.Length)
      if ($Read -le 0) {
        continue
      }
      $Request = [System.Text.Encoding]::ASCII.GetString($Buffer, 0, $Read)
      $RequestLine = ($Request -split "`r`n")[0]
      $Parts = $RequestLine -split " "
      if ($Parts.Length -lt 2 -or $Parts[0] -ne "GET") {
        Send-Response $Stream 405 "Method Not Allowed" ([System.Text.Encoding]::UTF8.GetBytes("Method Not Allowed")) "text/plain; charset=utf-8"
        continue
      }
      $RequestPath = [Uri]::UnescapeDataString(($Parts[1] -split "\?")[0].TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($RequestPath)) {
        $RequestPath = "index.html"
      }
      $FullPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $RequestPath))
      if (-not $FullPath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Response $Stream 403 "Forbidden" ([System.Text.Encoding]::UTF8.GetBytes("Forbidden")) "text/plain; charset=utf-8"
        continue
      }
      if (-not [System.IO.File]::Exists($FullPath)) {
        Send-Response $Stream 404 "Not Found" ([System.Text.Encoding]::UTF8.GetBytes("Not Found")) "text/plain; charset=utf-8"
        continue
      }
      $Bytes = [System.IO.File]::ReadAllBytes($FullPath)
      Send-Response $Stream 200 "OK" $Bytes (Get-ContentType $FullPath)
    } catch [System.ObjectDisposedException] {
      break
    } catch {
      Write-Warning "Request error: $($_.Exception.Message)"
    } finally {
      if ($null -ne $Client) {
        $Client.Close()
      }
    }
  }
} finally {
  if ($null -ne $Server) {
    $Server.Stop()
  }
}
