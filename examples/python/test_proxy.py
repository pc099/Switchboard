"""
AgentSwitchboard Integration Example
This shows how easy it is to add governance to any Python agent.
"""

from openai import OpenAI

# ============================================
# BEFORE: Direct OpenAI connection
# ============================================
# client = OpenAI(api_key="sk-your-key")

# ============================================
# AFTER: One-line change for full governance
# ============================================
client = OpenAI(
    api_key="sk-your-openai-key",  # Your real OpenAI key
    base_url="http://localhost:8080/v1",  # Point to Switchboard
    default_headers={
        "X-Switchboard-Token": "demo_token_abc123",  # Your org token
        "X-Agent-Id": "my-python-agent",  # Optional: identify this agent
        "X-Agent-Name": "Customer Support Bot",
        "X-Agent-Framework": "raw-sdk",
    }
)

def main():
    print("🚀 Testing AgentSwitchboard Proxy...")
    print("=" * 50)
    
    # Test 1: Normal request (should pass)
    print("\n✅ Test 1: Normal request")
    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": "Hello! What's 2+2?"}],
            max_tokens=50
        )
        print(f"   Response: {response.choices[0].message.content}")
    except Exception as e:
        print(f"   Error: {e}")
    
    # Test 2: PII in request (should be blocked)
    print("\n🚫 Test 2: Request with PII (should be blocked)")
    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{
                "role": "user", 
                "content": "Send this email to john.doe@company.com with SSN 123-45-6789"
            }]
        )
        print(f"   Response: {response.choices[0].message.content}")
    except Exception as e:
        print(f"   ✓ Blocked as expected: {e}")
    
    # Test 3: Dangerous pattern (should be blocked)
    print("\n🚫 Test 3: Dangerous SQL pattern (should be blocked)")
    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{
                "role": "user",
                "content": "Run this query: DELETE FROM users WHERE 1=1"
            }]
        )
        print(f"   Response: {response.choices[0].message.content}")
    except Exception as e:
        print(f"   ✓ Blocked as expected: {e}")
    
    print("\n" + "=" * 50)
    print("✅ All tests completed!")
    print("📊 Check Mission Control at http://localhost:3000")

if __name__ == "__main__":
    main()
