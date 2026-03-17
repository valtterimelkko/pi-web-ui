#!/usr/bin/env python3
"""
Visual verification of contrast fixes for light mode.
"""

from playwright.sync_api import sync_playwright

def test_contrast():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        
        # Load the test HTML file
        page.goto('file:///root/pi-web-ui/test-results/contrast_test.html')
        page.wait_for_load_state('networkidle')
        
        # Take screenshot
        page.screenshot(path='/root/pi-web-ui/test-results/contrast_fixes_comparison.png', full_page=True)
        print("Screenshot saved: contrast_fixes_comparison.png")
        
        browser.close()
        print("\nTest completed!")
        print("The screenshot shows the contrast improvements:")
        print("- Inline code now has darker background (slate-200) and bold text")
        print("- Code blocks now use light theme instead of dark")

if __name__ == '__main__':
    test_contrast()
