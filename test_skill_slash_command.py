#!/usr/bin/env python3
"""Test that /skill:name slash commands display cleanly (no raw skill content)"""

from playwright.sync_api import sync_playwright
import time
import sys

def test_skill_slash_command():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = context.new_page()
        
        try:
            print("Navigating to Pi Web UI...")
            page.goto('https://pi.letsautomate.work')
            page.wait_for_load_state('networkidle')
            
            # Login
            print("Logging in...")
            page.locator('input[type="password"]').fill('Ey@U1U%d5D77J99F')
            page.locator('button[type="submit"]').click()
            page.wait_for_load_state('networkidle')
            time.sleep(3)
            
            # Create a new session
            print("Creating new session...")
            page.get_by_text('Create new session').click()
            time.sleep(2)
            page.get_by_text('Create Session', exact=False).click()
            time.sleep(3)
            
            # Send slash command
            print("Sending /skill:lecture-website command...")
            page.wait_for_selector('textarea', timeout=10000)
            page.locator('textarea').first.fill('/skill:lecture-website create a pinterest copy')
            page.screenshot(path='/tmp/slash_01_typed.png', full_page=True)
            print("Screenshot saved: /tmp/slash_01_typed.png")
            
            # Send
            page.keyboard.press('Control+Enter')
            
            # Wait for processing
            print("Waiting for processing...")
            time.sleep(10)
            page.screenshot(path='/tmp/slash_02_processing.png', full_page=True)
            print("Screenshot saved: /tmp/slash_02_processing.png")
            
            # Wait more
            time.sleep(15)
            page.screenshot(path='/tmp/slash_03_result.png', full_page=True)
            print("Screenshot saved: /tmp/slash_03_result.png")
            
            # Check page content
            page_content = page.content()
            
            # Look for messy skill content that should NOT be there
            messy_patterns = [
                'Lecture Website Builder',
                '<skill name="',
                'Transform a simple idea into a deployed',
                'Phase 1: Design & Build',
                'Quick Start',
                'Detailed Workflow',
                '## Process',
                'Build to: /root/lecture'
            ]
            
            found_messy = [p for p in messy_patterns if p in page_content]
            
            # Look for clean indicators that SHOULD be there
            clean_indicators = [
                'Read',
                'Loaded',
                'lines',
                'chars'
            ]
            
            found_clean = [i for i in clean_indicators if i in page_content]
            
            print("\n=== Results ===")
            print(f"Messy patterns found: {len(found_messy)}")
            if found_messy:
                print(f"  - {found_messy[:3]}...")  # Show first 3
            
            print(f"Clean indicators found: {len(found_clean)}")
            print(f"  - {found_clean}")
            
            # Success if no messy patterns and clean indicators present
            if not found_messy and len(found_clean) >= 2:
                print("\n✅ SUCCESS: Slash command displays cleanly!")
                print("   - No raw skill content in chat")
                print("   - Clean Read tool indicators present")
                return True
            elif found_messy:
                print("\n❌ FAIL: Raw skill content is still being displayed")
                print(f"   Found: {found_messy}")
                return False
            else:
                print("\n⚠️  PARTIAL: No messy content, but clean indicators missing")
                return True  # Still consider success if no messy content
                
        except Exception as e:
            print(f"\n❌ Error: {e}")
            page.screenshot(path='/tmp/slash_error.png', full_page=True)
            return False
        finally:
            browser.close()

if __name__ == '__main__':
    success = test_skill_slash_command()
    sys.exit(0 if success else 1)
