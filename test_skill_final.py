#!/usr/bin/env python3
"""Final test for skill slash command display"""

from playwright.sync_api import sync_playwright
import time
import sys

def test_skill_slash_command():
    with sync_playwright() as p:
        # Create fresh browser context with no cache
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            bypass_csp=True
        )
        page = context.new_page()
        
        try:
            print("Navigating to Pi Web UI...")
            page.goto('https://pi.letsautomate.work', wait_until='networkidle')
            
            # Login
            print("Logging in...")
            page.locator('input[type="password"]').fill('Ey@U1U%d5D77J99F')
            page.locator('button[type="submit"]').click()
            page.wait_for_load_state('networkidle')
            time.sleep(3)
            
            # Create new session
            print("Creating new session...")
            page.get_by_text('Create new session').first.click()
            time.sleep(2)
            page.get_by_text('Create Session').first.click()
            time.sleep(3)
            
            # Type the slash command
            print("Sending slash command...")
            page.locator('textarea').first.fill('/skill:lecture-website create a pinterest copy')
            page.keyboard.press('Control+Enter')
            
            # Wait for processing
            print("Waiting for processing...")
            time.sleep(15)
            page.screenshot(path='/tmp/final_test.png', full_page=True)
            print("Screenshot saved: /tmp/final_test.png")
            
            # Get content
            content = page.content()
            
            # Check for skill content
            skill_patterns = ['<skill name="', 'Lecture Website Builder', '## Process', 'Phase 1:']
            found_skill = [p for p in skill_patterns if p in content]
            
            print(f"\nSkill patterns found: {len(found_skill)}")
            if found_skill:
                print(f"  {found_skill}")
                print("\n❌ Skill content is still visible")
                return False
            else:
                print("  None - Skill content is hidden!")
                print("\n✅ SUCCESS: Skill content is filtered!")
                return True
                
        except Exception as e:
            print(f"Error: {e}")
            page.screenshot(path='/tmp/final_error.png', full_page=True)
            return False
        finally:
            browser.close()

if __name__ == '__main__':
    success = test_skill_slash_command()
    sys.exit(0 if success else 1)
