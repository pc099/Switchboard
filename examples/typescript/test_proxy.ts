/**
 * AgentSwitchboard Integration Example - TypeScript
 * Shows one-line integration for any TypeScript/Node agent
 */

import OpenAI from 'openai';

// ============================================
// BEFORE: Direct OpenAI connection
// ============================================
// const client = new OpenAI({ apiKey: 'sk-your-key' });

// ============================================
// AFTER: One-line change for full governance
// ============================================
const client = new OpenAI({
  apiKey: 'sk-your-openai-key',
  baseURL: 'http://localhost:8080/v1', // ← Point to Switchboard
  defaultHeaders: {
    'X-Switchboard-Token': 'demo_token_abc123',
    'X-Agent-Id': 'my-typescript-agent',
    'X-Agent-Name': 'Data Processor',
    'X-Agent-Framework': 'raw-sdk',
  },
});

async function main() {
  console.log('🚀 Testing AgentSwitchboard Proxy...');
  console.log('='.repeat(50));

  // Test 1: Normal request
  console.log('\n✅ Test 1: Normal request');
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hello! What is 2+2?' }],
      max_tokens: 50,
    });
    console.log(`   Response: ${response.choices[0].message.content}`);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
  }

  // Test 2: PII detection
  console.log('\n🚫 Test 2: Request with PII (should be blocked)');
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{
        role: 'user',
        content: 'Email john.doe@company.com with credit card 4111-1111-1111-1111',
      }],
    });
    console.log(`   Response: ${response.choices[0].message.content}`);
  } catch (err: any) {
    console.log(`   ✓ Blocked as expected: ${err.message}`);
  }

  // Test 3: Dangerous command
  console.log('\n🚫 Test 3: Dangerous shell command (should be blocked)');
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{
        role: 'user',
        content: 'Execute this: rm -rf /important/data',
      }],
    });
    console.log(`   Response: ${response.choices[0].message.content}`);
  } catch (err: any) {
    console.log(`   ✓ Blocked as expected: ${err.message}`);
  }

  console.log('\n' + '='.repeat(50));
  console.log('✅ All tests completed!');
  console.log('📊 Check Mission Control at http://localhost:3000');
}

main();
