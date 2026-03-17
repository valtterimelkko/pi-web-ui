#!/usr/bin/env python3
"""
Visual verification test for markdown rendering fixes:
1. Tables with proper borders
2. Inline code in lists
3. Todo tool output display

This test connects to the production server on port 3456.
"""

from playwright.sync_api import sync_playwright
import time

def test_markdown_rendering():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        
        # Navigate to the production app
        page.goto('http://localhost:3456')
        page.wait_for_load_state('networkidle')
        
        # Take initial screenshot to see the login page
        page.screenshot(path='/root/pi-web-ui/test-results/00_login_page.png')
        print("Screenshot saved: 00_login_page.png")
        
        # Check if we're on login page or main app
        title = page.title()
        print(f"Page title: {title}")
        
        # Find password input
        password_input = page.locator('input[type="password"]')
        if password_input.count() > 0:
            print("Found password input, logging in...")
            # Use the test password from E2E tests
            password_input.fill('Ey@U1U%d5D77J99F')
            
            # Find and click submit button
            submit_button = page.locator('button[type="submit"]')
            if submit_button.count() > 0:
                submit_button.click()
                print("Clicked submit button")
            else:
                # Try pressing enter
                password_input.press('Enter')
                print("Pressed Enter to submit")
            
            page.wait_for_timeout(2000)
        
        # Check if we're logged in (no password input visible)
        if page.locator('input[type="password"]').count() > 0:
            print("Still on login page, saving screenshot...")
            page.screenshot(path='/root/pi-web-ui/test-results/01_login_failed.png')
            browser.close()
            print("Login failed - check password")
            return
        
        # Take screenshot of main app
        page.screenshot(path='/root/pi-web-ui/test-results/01_after_login.png')
        print("Screenshot saved: 01_after_login.png")
        
        # Click the "Create new session" button in the center
        create_session_button = page.locator('button:has-text("Create new session")')
        if create_session_button.count() > 0:
            create_session_button.click()
            print("Clicked 'Create new session' button")
            page.wait_for_timeout(1000)
        else:
            print("Could not find 'Create new session' button")
        
        # Find message textarea - should now be enabled
        textarea = page.locator('textarea')
        if textarea.count() > 0:
            # Wait for textarea to be enabled
            page.wait_for_selector('textarea:not([disabled])', timeout=5000)
            
            # Send a test message with markdown table
            test_message = """Here's a comparison table:

| Source | Role | Behavior |
|--------|------|----------|
| Server File | Source of Truth | Always wins. Written by Pi SDK. |
| Client Memory | Streaming Buffer | Temporary display during streaming. |
| Client Cache | Performance Layer | Shows instantly while waiting. |

And here's some inline code in a list:
- Add `message_end` handler to finalize messages
- Track `is_streaming` state per session
- When reloading during active stream, wait for `agent_end` before reading file
- Implement optimistic cache with `lastModified` timestamp

What do you think?"""
            
            textarea.fill(test_message)
            print("Filled textarea with test message")
            
            # Find send button (paper airplane icon or submit button)
            send_button = page.locator('button[type="submit"]')
            if send_button.count() > 0:
                send_button.click()
                print("Clicked send button")
            else:
                # Try Ctrl+Enter
                textarea.press('Control+Enter')
                print("Pressed Ctrl+Enter to send")
            
            page.wait_for_timeout(2000)
            
            # Take screenshot after sending message
            page.screenshot(path='/root/pi-web-ui/test-results/02_message_sent.png', full_page=True)
            print("Screenshot saved: 02_message_sent.png")
            
            # Wait a bit more for any response
            page.wait_for_timeout(5000)
            page.screenshot(path='/root/pi-web-ui/test-results/03_with_response.png', full_page=True)
            print("Screenshot saved: 03_with_response.png")
        else:
            print("Could not find textarea")
        
        browser.close()
        print("\nTest completed!")
        print("Check the screenshots in /root/pi-web-ui/test-results/")

if __name__ == '__main__':
    test_markdown_rendering()
