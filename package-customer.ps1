$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$releaseDirectory = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$names = @(
    'package.json', 'package-lock.json', 'server.mjs', 'cloud-server.mjs',
    'client-server.mjs', 'client-store.mjs', 'pg-store.mjs', 'pg-adapter.mjs',
    'model-services.mjs', 'workspace.mjs', 'evidence.mjs', 'manage.mjs', 'dist',
    'netlify', 'netlify.toml', 'Dockerfile', 'compose.yaml', 'Caddyfile',
    '.dockerignore', '.gitignore', '.env.example', '.env.customer.example',
    '.env.netlify.example', '.github', 'scripts', 'README.md',
    'CUSTOMER-DELIVERY.md', 'NETLIFY-DEPLOY.md', 'SECURITY.md', 'LICENSE',
    'MODEL_COLLAB.md', 'TalentLens_简历片段.txt', 'docs', 'quality-fixtures.json',
    'test.mjs', 'test-jd.mjs', 'test-deepseek.mjs', 'test-batch.mjs',
    'test-optimized.mjs', 'test-http.mjs', 'test-customer.mjs', 'test-cloud.mjs',
    'live-smoke.mjs'
)
$files = $names | ForEach-Object { Join-Path $projectRoot $_ }
foreach ($file in $files) { if (-not (Test-Path -LiteralPath $file)) { throw "Missing release file: $file" } }
$target = Join-Path $releaseDirectory 'TalentLens-customer-1.0.0.zip'
Compress-Archive -LiteralPath $files -DestinationPath $target -CompressionLevel Optimal -Force
$archive = [System.IO.Compression.ZipFile]::OpenRead($target)
try {
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -match '(^|/)(data|node_modules)/|(^|/)\.env$|\.sqlite(-wal|-shm)?$') { throw "Sensitive or runtime file in release: $($entry.FullName)" }
    }
    Write-Output "Release verified: $($archive.Entries.Count) entries; no runtime data or real .env."
} finally { $archive.Dispose() }
Write-Output $target
