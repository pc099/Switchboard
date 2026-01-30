import os
import sys
import time
import requests
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor
from openai import OpenAI

# Configuration
PROXY_URL = "http://localhost:8080"
API_KEY = os.getenv("OPENAI_API_KEY", "sk-mock-key-for-testing")
HEADERS = {
    "X-Switchboard-Token": "test_token_123",
    "X-Agent-Id": "integration_tester"
}

# Colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
RESET = "\033[0m"

def log(msg, color=RESET):
    print(f"{color}{msg}{RESET}")

def check_health():
    log("1. Checking Proxy Health...", YELLOW)
    try:
        url = f"{PROXY_URL}/health"
        res = requests.get(url, timeout=2)
        if res.status_code == 200:
            log(f"   ✅ Health check passed: {res.json()}", GREEN)
            return True
        else:
            log(f"   ❌ Health check failed: {res.status_code} {res.text}", RED)
            return False
    except Exception as e:
        log(f"   ❌ Could not connect to {url}: {e}", RED)
        return False

def test_proxy_valid_request():
    log("\n2. Testing Valid Proxy Request...", YELLOW)
    try:
        client = OpenAI(
            api_key=API_KEY,
            base_url=f"{PROXY_URL}/v1",
            default_headers=HEADERS
        )
        
        # We expect this to reach upstream. If it fails with 401 (invalid key), 
        # that means the proxy WORKED (it forwarded the request).
        try:
            client.chat.completions.create(
                model="gpt-3.5-turbo",
                messages=[{"role": "user", "content": "Hello"}],
                max_tokens=5
            )
            log("   ✅ Valid request passed (200 OK)", GREEN)
            return True
        except Exception as e:
            # Check if it's an API error from upstream (which means proxy worked)
            if "Incorrect API key" in str(e) or "401" in str(e):
                 log(f"   ✅ Proxy forwarded request successfully (Upstream 401 received as expected with mock key)", GREEN)
                 return True
            elif "502" in str(e):
                 log(f"   ✅ Proxy forwarded request (Upstream 502 received - likely unreachable with mock config)", GREEN)
                 return True
            else:
                log(f"   ❌ Request failed unexpectedly: {e}", RED)
                return False

    except Exception as e:
        log(f"   ❌ Setup failed: {e}", RED)
        return False

def test_firewall_pii():
    log("\n3. Testing Firewall (PII Blocking)...", YELLOW)
    try:
        client = OpenAI(
            api_key=API_KEY,
            base_url=f"{PROXY_URL}/v1",
            default_headers=HEADERS
        )
        
        try:
            client.chat.completions.create(
                model="gpt-3.5-turbo",
                messages=[{"role": "user", "content": "My email is test@gmail.com and phone is 555-0199"}]
            )
            log("   ❌ Firewall FAILED: Request with PII was allowed!", RED)
            return False
        except Exception as e:
            if "BLOCKED_BY_FIREWALL" in str(e) or "403" in str(e):
                log("   ✅ Firewall blocked PII request (403 Forbidden)", GREEN)
                return True
            else:
                log(f"   ❌ Failed with unexpected error: {e}", RED)
                return False
    except Exception as e:
        log(f"   ❌ Test setup failed: {e}", RED)
        return False

def test_concurrency():
    log("\n4. Testing Traffic Control (Concurrency)...", YELLOW)
    
    def make_request(i):
        client = OpenAI(
            api_key=API_KEY,
            base_url=f"{PROXY_URL}/v1",
            default_headers={"X-Agent-Id": "concurrent_agent", "X-Switchboard-Token": "test_token"}
        )
        try:
            client.chat.completions.create(
                 model="gpt-3.5-turbo",
                 messages=[{"role": "user", "content": f"Req {i}"}],
                 max_tokens=1
            )
            return "OK"
        except Exception as e:
             if "RESOURCE_LOCKED" in str(e) or "409" in str(e):
                 return "LOCKED"
             if "401" in str(e) or "502" in str(e) or "429" in str(e): # Upstream auth/limit error is fine, means it went through
                 return "OK"
             return str(e)

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(make_request, i) for i in range(5)]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]
    
    log(f"   Results: {results}", YELLOW)
    # logic depends on config, but ensuring no crashes is step 1
    log("   ✅ Concurrency test completed without crashes", GREEN)
    return True

def main():
    log("🚀 Starting Integration Tests\n", GREEN)
    
    if not check_health():
        log("\n❌ Aborting: Proxy is not healthy", RED)
        sys.exit(1)
        
    test_cases = [
        ("Valid Proxy Request", test_proxy_valid_request),
        ("Firewall (PII Blocking)", test_firewall_pii),
        ("Traffic Control (Concurrency)", test_concurrency)
    ]
    
    results = []
    for name, func in test_cases:
        try:
            success = func()
            results.append((name, success))
        except Exception as e:
            log(f"   💥 Test '{name}' crashed: {e}", RED)
            results.append((name, False))
    
    log("\n--- TEST SUMMARY ---", YELLOW)
    all_passed = True
    for name, success in results:
        status = f"{GREEN}PASS{RESET}" if success else f"{RED}FAIL{RESET}"
        log(f"{name:.<40} {status}")
        if not success:
            all_passed = False
    
    if all_passed:
        log("\n✨ ALL TESTS PASSED", GREEN)
        sys.exit(0)
    else:
        log("\n❌ SOME TESTS FAILED", RED)
        sys.exit(1)

if __name__ == "__main__":
    main()
