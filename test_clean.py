#!/usr/bin/env python3
"""Test with completely fresh session"""

from playwright.sync_api import sync_playwright
import time

def test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            bypass_csp=True
        )
        # Clear all cookies/storage
        context.clear_cookies()
        
        page = context.new_page()
        
        # Load with cache busting
        ts = str(int(time.time()))
        page.goto(f'https://pi.letsautomate.work?cb={ts}', wait_until='networkidle')
        
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
        page.locator('textarea').first.fill('/skill:lecture-website test')
        page.keyboard.press('Control+Enter')
        time.sleep(12)
        
        # Get all text content
        html = page.content()
        
        # Check for skill patterns
        patterns = ['<skill name="', '</skill>', 'Lecture Website Builder', '## Process']
        found = []
        for p in patterns:
            if p in html:
                found.append(p)
                # Show context
                idx = html.find(p)
                print(f"\nFound '{p}' at position {idx}")
                print(f"Context: ...{html[max(0,idx-50):idx+50]}...")
        
        page.screenshot(path='/tmp/clean_test.png', full_page=True)
        print(f"\nScreenshot: /tmp/clean_test.png")
        print(f"Patterns found: {len(found)}")
        
        browser.close()
        return len(found) == 0

if __name__ == '__main__':
    import sys
    success = test()
    sys.exit(0 if success else 1)
