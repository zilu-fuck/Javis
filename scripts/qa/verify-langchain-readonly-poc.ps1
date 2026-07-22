param(
    [string]$OutputPath
)

$apiKey = $env:DEEPSEEK_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $blocked = [ordered]@{
        status = 'blocked'
        reason = 'DEEPSEEK_API_KEY is not set.'
        scenario = 'langchain-phase2-readonly-poc'
    } | ConvertTo-Json -Depth 5
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        Set-Content -LiteralPath $OutputPath -Value $blocked -Encoding utf8
    }
    Write-Output $blocked
    exit 2
}

$env:JAVIS_RUN_LANGCHAIN_LIVE = '1'
$testOutput = & corepack pnpm --filter '@javis/desktop' exec vitest run src/agent-runtime/langchain/live-poc.test.ts --reporter=verbose 2>&1
$testExitCode = $LASTEXITCODE
$testOutput | Write-Output
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    Set-Content -LiteralPath $OutputPath -Value $testOutput -Encoding utf8
}
exit $testExitCode
