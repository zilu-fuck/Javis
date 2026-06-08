$apiKey = $env:DEEPSEEK_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'Set DEEPSEEK_API_KEY before running this QA script.'
}
$model = 'deepseek-v4-flash'

$body = @{
    model = $model
    messages = @(
        @{role = 'system'; content = 'Return only the requested JSON object. Do not include markdown fences or explanation.'},
        @{role = 'user'; content = "Analyze this diff and return a JSON proposal with summary, changedFiles, and patch fields.`n`ndiff --git a/README.md b/README.md`n--- a/README.md`n+++ b/README.md`n@@ -1,3 +1,3 @@`n-# Hello World`n+# Hello Javis`n This is a test project."}
    )
    stream = $false
    temperature = 0
    max_tokens = 4096
    thinking = @{type = 'disabled'}
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "=== Test 1: URL with /v1 ==="
try {
    $response = Invoke-RestMethod -Uri 'https://api.deepseek.com/v1/chat/completions' -Method Post -Body $body -ContentType 'application/json' -Headers @{Authorization = "Bearer $apiKey"}
    $content = $response.choices[0].message.content
    Write-Host "HTTP 200 - PASS"
    Write-Host "Proposal content:"
    Write-Host $content
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "=== Test 2: URL without /v1 ==="
try {
    $response = Invoke-RestMethod -Uri 'https://api.deepseek.com/chat/completions' -Method Post -Body $body -ContentType 'application/json' -Headers @{Authorization = "Bearer $apiKey"}
    $content = $response.choices[0].message.content
    Write-Host "HTTP 200 - PASS"
    Write-Host "Proposal content:"
    Write-Host $content
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
}
