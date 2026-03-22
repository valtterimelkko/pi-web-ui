#!/usr/bin/env python3
"""Final test with cache busting"""

from playwright.sync_api import sync_playwright
import time
import sys

def test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            bypass_csp=True
        )
        page = context.new_page()
        
        try:
            # Add cache-busting parameter
            print("Loading with cache busting...")
            page.goto('https://pi.letsautomate.work?v=' + str(int(time.time())), wait_until='networkidle')
            
            page.locator('input[type="password"]').fill('Ey@U1U%d5D77J99F')
            page.locator('button[type="submit"]').click()
            page.wait_for_load_state('networkidle')
            time.sleep(3)
            
            # Create new session
            page.get_by_text('Create new session').first.click()
            time.sleep(2)
            page.get_by_text('Create Session').first.click()
            time.sleep(3)
            
            # Send slash command
            print("Sending command...")
            page.locator('textarea').first.fill('/skill:lecture-website create a pinterest copy')
            page.keyboard.press('Control+Enter')
            time.sleep(15)
            
            page.screenshot(path='/tmp/final_result.png', full_page=True)
            
            # Check content
            content = page.content()
            skill_patterns = ['<skill name="', '</skill>', 'Lecture Website Builder', '## Process']
            found = [p for p in skill_patterns if p in content]
            
            print(f"Skill patterns found: {len(found)}")
            if found:
                print(f"  {found}")
                return False
            else:
                print("  None - Clean!")
                return True
                
        finally:
            browser.close()

if __name__ == '__main__':
    success = test()
    sys.exit(0 if success else 1)
