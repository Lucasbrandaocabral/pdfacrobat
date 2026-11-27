// Tipo de papel, qualidade e resolução da impressora, no Windows.
//
// A impressão do app vai direto para a impressora, sem a janela do sistema,
// e o Chromium só escolhe impressora, cópias, cor, frente e verso, papel e
// DPI. O tipo de papel (fotográfico, brilhante...) e a qualidade ficam nas
// preferências da impressora. Aqui o PowerShell lê as opções que o driver
// oferece (PrintCapabilities) e, só durante a impressão, grava a escolha nas
// preferências do usuário (UserPrintTicket), que o Chromium lê ao imprimir.
// Depois da impressão, as preferências voltam ao que eram (e, se o app fechar
// no meio, voltam na próxima vez que ele abrir).
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSF = 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework'
$PSK = 'http://schemas.microsoft.com/windows/2003/08/printing/printschemakeywords'
$FEATURES = [ordered]@{ media = 'PageMediaType'; quality = 'PageOutputQuality'; resolution = 'PageResolution' }

function Get-Queue([string]$name) {
  if (-not $name) { return (New-Object System.Printing.LocalPrintServer).DefaultPrintQueue }
  if ($name -match '^(\\\\[^\\]+)\\(.+)$') {
    return (New-Object System.Printing.PrintServer($Matches[1])).GetPrintQueue($Matches[2])
  }
  return (New-Object System.Printing.LocalPrintServer).GetPrintQueue($name)
}

function Read-Xml($stream) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.Load($stream)
  return $doc
}

function Expand-Name($node, [string]$qname) {
  if (-not $qname) { return '' }
  $i = $qname.IndexOf(':')
  if ($i -lt 0) { return '{}' + $qname }
  return '{' + $node.GetNamespaceOfPrefix($qname.Substring(0, $i)) + '}' + $qname.Substring($i + 1)
}

function Find-Feature($doc, [string]$local) {
  foreach ($f in $doc.GetElementsByTagName('Feature', $PSF)) {
    if ((Expand-Name $f $f.GetAttribute('name')) -eq ('{' + $PSK + '}' + $local)) { return $f }
  }
  return $null
}

function Get-Values($el, [string]$kind) {
  $map = @{}
  foreach ($c in $el.ChildNodes) {
    if ($c.NodeType -ne 'Element' -or $c.NamespaceURI -ne $PSF -or $c.LocalName -ne $kind) { continue }
    $value = $null
    foreach ($d in $c.ChildNodes) { if ($d.NodeType -eq 'Element' -and $d.LocalName -eq 'Value') { $value = $d.InnerText } }
    $map[(Expand-Name $c $c.GetAttribute('name'))] = $value
  }
  return $map
}

function Get-Key($opt) {
  $name = $opt.GetAttribute('name')
  if ($name) { return Expand-Name $opt $name }
  $s = Get-Values $opt 'ScoredProperty'
  $x = $s['{' + $PSK + '}ResolutionX']
  if ($x) { return 'res:' + $x + ':' + $s['{' + $PSK + '}ResolutionY'] }
  return ''
}

function Get-Options($doc, [string]$local) {
  $list = @()
  $f = Find-Feature $doc $local
  if (-not $f) { return }
  foreach ($o in $f.ChildNodes) {
    if ($o.NodeType -ne 'Element' -or $o.NamespaceURI -ne $PSF -or $o.LocalName -ne 'Option') { continue }
    $key = Get-Key $o
    if (-not $key) { continue }
    $label = (Get-Values $o 'Property')['{' + $PSK + '}DisplayName']
    if (-not $label) { $label = $key -replace '^\{[^}]*\}', '' }
    $s = Get-Values $o 'ScoredProperty'
    $list += [pscustomobject]@{
      key = $key; label = $label; node = $o
      x = [int]('0' + $s['{' + $PSK + '}ResolutionX']); y = [int]('0' + $s['{' + $PSK + '}ResolutionY'])
    }
  }
  return $list
}

function Get-Current($doc, [string]$local) {
  $f = Find-Feature $doc $local
  if (-not $f) { return '' }
  foreach ($o in $f.ChildNodes) { if ($o.NodeType -eq 'Element' -and $o.LocalName -eq 'Option') { return Get-Key $o } }
  return ''
}

try {
  Add-Type -AssemblyName System.Printing
  Add-Type -AssemblyName ReachFramework
  $q = Get-Queue $env:PDFA_PRINTER
  $action = $env:PDFA_ACTION

  if ($action -eq 'restore') {
    if ($env:PDFA_TICKET_FILE -and (Test-Path -LiteralPath $env:PDFA_TICKET_FILE)) {
      $bytes = [System.IO.File]::ReadAllBytes($env:PDFA_TICKET_FILE)
      $q.UserPrintTicket = [System.Printing.PrintTicket]::new([System.IO.MemoryStream]::new($bytes))
    } else {
      $q.UserPrintTicket = $q.DefaultPrintTicket
    }
    $q.Commit()
    @{ ok = $true } | ConvertTo-Json -Compress
    return
  }

  $caps = Read-Xml ($q.GetPrintCapabilitiesAsXml())
  $user = $q.UserPrintTicket
  $base = if ($user) { $user } else { $q.DefaultPrintTicket }
  $ticket = Read-Xml ($base.GetXmlStream())

  if ($action -eq 'caps') {
    $out = [ordered]@{ ok = $true; current = [ordered]@{} }
    foreach ($k in $FEATURES.Keys) {
      $out[$k] = @(Get-Options $caps $FEATURES[$k] | ForEach-Object { [pscustomobject]@{ key = $_.key; label = $_.label; x = $_.x; y = $_.y } })
      $out.current[$k] = Get-Current $ticket $FEATURES[$k]
    }
    $out | ConvertTo-Json -Depth 5 -Compress
    return
  }

  # apply: guarda as preferências de agora e grava a escolha por cima.
  $choice = $env:PDFA_CHOICE | ConvertFrom-Json
  $delta = New-Object System.Xml.XmlDocument
  $root = $delta.CreateElement('psf', 'PrintTicket', $PSF)
  $root.SetAttribute('version', '1')
  foreach ($a in $caps.DocumentElement.Attributes) {
    if ($a.Prefix -ne 'xmlns') { continue }
    $copy = $delta.CreateAttribute('xmlns', $a.LocalName, 'http://www.w3.org/2000/xmlns/')
    $copy.Value = $a.Value
    [void]$root.Attributes.Append($copy)
  }
  # Os prefixos que o tíquete usa nos nomes e nos tipos dos valores.
  $NEEDED = [ordered]@{ psf = $PSF; psk = $PSK; xsi = 'http://www.w3.org/2001/XMLSchema-instance'; xsd = 'http://www.w3.org/2001/XMLSchema' }
  foreach ($p in $NEEDED.Keys) {
    if ($root.HasAttribute('xmlns:' + $p)) { continue }
    $copy = $delta.CreateAttribute('xmlns', $p, 'http://www.w3.org/2000/xmlns/')
    $copy.Value = $NEEDED[$p]
    [void]$root.Attributes.Append($copy)
  }
  [void]$delta.AppendChild($root)
  $changed = 0
  foreach ($k in $FEATURES.Keys) {
    $want = $choice.$k
    if (-not $want) { continue }
    $f = Find-Feature $caps $FEATURES[$k]
    $opt = Get-Options $caps $FEATURES[$k] | Where-Object { $_.key -eq $want } | Select-Object -First 1
    if (-not $f -or -not $opt) { continue }
    $feature = $delta.CreateElement('psf', 'Feature', $PSF)
    $feature.SetAttribute('name', 'psk:' + $FEATURES[$k])
    $node = $delta.ImportNode($opt.node, $true)
    foreach ($c in @($node.ChildNodes)) { if ($c.LocalName -eq 'Property') { [void]$node.RemoveChild($c) } }
    [void]$feature.AppendChild($node)
    [void]$root.AppendChild($feature)
    $changed++
  }
  if ($changed -eq 0) {
    @{ ok = $true; changed = 0 } | ConvertTo-Json -Compress
    return
  }
  if ($user) {
    [System.IO.File]::WriteAllBytes($env:PDFA_TICKET_FILE, $user.GetXmlStream().ToArray())
  } elseif (Test-Path -LiteralPath $env:PDFA_TICKET_FILE) {
    Remove-Item -LiteralPath $env:PDFA_TICKET_FILE
  }
  $stream = New-Object System.IO.MemoryStream
  $delta.Save($stream)
  $stream.Position = 0
  $result = $q.MergeAndValidatePrintTicket($base, [System.Printing.PrintTicket]::new($stream))
  $q.UserPrintTicket = $result.ValidatedPrintTicket
  $q.Commit()
  @{ ok = $true; changed = $changed } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");
const supported = process.platform === "win32";
let stateDir = null;

/** Roda o script com `env` (PDFA_*) e devolve o JSON que ele escreveu. */
function run(env) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const line = String(stdout || "").trim().split(/\r?\n/).pop();
        let result = null;
        try {
          result = JSON.parse(line);
        } catch {
          return reject(err || new Error("O PowerShell não respondeu."));
        }
        if (!result.ok) return reject(new Error(result.error || "A impressora não aceitou as preferências."));
        resolve(result);
      },
    );
  });
}

const cache = new Map();

/**
 * As opções do driver da impressora `name` ("" = a padrão):
 * { media, quality, resolution: [{ key, label, x, y }], current: { media, quality, resolution } },
 * ou null fora do Windows ou se o driver não disser.
 */
async function capabilities(name) {
  if (!supported) return null;
  const key = name || "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < 5 * 60_000) return hit.value;
  const value = await run({ PDFA_ACTION: "caps", PDFA_PRINTER: key }).catch(() => null);
  const list = (items) => (Array.isArray(items) ? items : items ? [items] : []).filter((o) => o?.key && o?.label);
  const result = value && {
    media: list(value.media),
    quality: list(value.quality),
    resolution: list(value.resolution),
    current: value.current || {},
  };
  cache.set(key, { time: Date.now(), value: result });
  return result;
}

const pendingFile = () => path.join(stateDir, "impressao-preferencias.json");
const ticketFile = () => path.join(stateDir, "impressao-preferencias.xml");

/**
 * Grava `choice` ({ media, quality, resolution }: chaves de capabilities)
 * nas preferências da impressora. Devolve o que é preciso para restore().
 */
async function apply(name, choice) {
  const wanted = Object.fromEntries(["media", "quality", "resolution"].map((k) => [k, typeof choice?.[k] === "string" ? choice[k] : ""]));
  if (!supported || !stateDir || !Object.values(wanted).some(Boolean)) return null;
  const printer = name || "";
  // Primeiro anota que há preferências a desfazer: se o app fechar no meio, desfaz ao abrir.
  await fs.writeFile(pendingFile(), JSON.stringify({ printer }));
  const result = await run({ PDFA_ACTION: "apply", PDFA_PRINTER: printer, PDFA_CHOICE: JSON.stringify(wanted), PDFA_TICKET_FILE: ticketFile() }).catch(async (err) => {
    await fs.rm(pendingFile(), { force: true });
    throw err;
  });
  if (!result.changed) {
    await fs.rm(pendingFile(), { force: true });
    return null;
  }
  return { printer };
}

/** Volta as preferências da impressora ao que eram antes de apply(). */
async function restore(applied) {
  if (!applied) return;
  await run({ PDFA_ACTION: "restore", PDFA_PRINTER: applied.printer, PDFA_TICKET_FILE: ticketFile() });
  await fs.rm(pendingFile(), { force: true });
  await fs.rm(ticketFile(), { force: true });
}

/** Na abertura do app: `dir` guarda as preferências; desfaz uma impressão interrompida. */
async function init(dir) {
  stateDir = dir;
  if (!supported) return;
  const pending = await fs
    .readFile(pendingFile(), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (pending) await restore({ printer: String(pending.printer || "") }).catch(() => {});
}

module.exports = { supported, capabilities, apply, restore, init };
