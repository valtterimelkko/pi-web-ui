#!/usr/bin/env python3
"""
Comprehensive E2E test for Pi Web UI
Tests: Login, Session creation, Chat, Slash commands, UI components
"""

import os
import sys
import time
from playwright.sync_api import sync_playwright, expect

# Configuration
BASE_URL = "http://localhost:3457"
API_URL = "http://localhost:3456"
SCREENSHOT_DIR = "/root/pi-web-ui/tests/screenshots"

# Ensure screenshot directory exists
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

def timestamp():
    """Get current timestamp for screenshots."""
    from datetime import datetime
    return datetime.now().strftime("%H%M%S")

def test_pi_web_ui():
    """Run comprehensive E2E tests."""
    
    print("="*60)
    print("Pi Web UI - Comprehensive E2E Test Suite")
    print("="*60)
    
    with sync_playwright() as p:
        # Launch browser
        print("\n[1/9] Launching browser...")
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()
        
        # Capture console logs
        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"{msg.type}: {msg.text}"))
        
        # Capture page errors
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        
        try:
            # Navigate to the app
            print("\n[2/9] Navigating to application...")
            page.goto(BASE_URL, timeout=30000)
            page.wait_for_load_state('networkidle', timeout=30000)
            time.sleep(1)
            
            # Capture landing state screenshot (login page)
            landing_screenshot = f"{SCREENSHOT_DIR}/01_landing_state_{timestamp()}.png"
            page.screenshot(path=landing_screenshot, full_page=True)
            print(f"  ✓ Screenshot saved: {landing_screenshot}")
            
            # Test login
            print("\n[3/9] Testing authentication...")
            
            # Check if we're on the login page by looking for password input
            password_input = page.locator('input#password')
            
            if password_input.count() > 0:
                print("  ✓ Login form detected (password-only auth)")
                
                # Fill in password
                password_input.fill("admin")
                print("  ✓ Password filled")
                
                # Click Sign In button
                signin_button = page.locator('button[type="submit"]')
                signin_button.click()
                print("  ✓ Sign In clicked")
                
                # Wait for authentication and app to load
                time.sleep(3)
                
                # Check if we're now authenticated (look for sidebar or chat)
                sidebar = page.locator('.w-80, [class*="sidebar"], button[title*="New session"]').first
                if sidebar.count() > 0:
                    print("  ✓ Login successful - app loaded")
                else:
                    # Check for error message
                    error_msg = page.locator('.text-red, [class*="error"], .bg-red-900').first
                    if error_msg.count() > 0:
                        print(f"  ✗ Login error: {error_msg.text_content()}")
                    else:
                        print("  ⚠ Login status unclear - taking screenshot")
            else:
                print("  ⚠ No password input found - might already be authenticated")
            
            # Take screenshot after login
            auth_screenshot = f"{SCREENSHOT_DIR}/02_after_login_{timestamp()}.png"
            page.screenshot(path=auth_screenshot, full_page=True)
            print(f"  ✓ Screenshot saved: {auth_screenshot}")
            
            # Test creating a new session
            print("\n[4/9] Testing session creation...")
            
            try:
                # Find and click New Session button (Plus icon)
                new_session_btn = page.locator('button[title="New session"], button:has(svg)').first
                
                if new_session_btn.count() > 0:
                    new_session_btn.click()
                    print("  ✓ Clicked 'New Session' button")
                    time.sleep(1)
                else:
                    print("  ⚠ New session button not found")
                    
            except Exception as e:
                print(f"  ⚠ Session creation error: {e}")
            
            # Take screenshot after creating session
            session_screenshot = f"{SCREENSHOT_DIR}/03_session_created_{timestamp()}.png"
            page.screenshot(path=session_screenshot, full_page=True)
            print(f"  ✓ Screenshot saved: {session_screenshot}")
            
            # Test sending a message
            print("\n[5/9] Testing chat message...")
            
            try:
                # Find the message textarea
                message_input = page.locator('textarea[placeholder*="Type a message"], textarea').first
                
                if message_input.count() > 0:
                    print("  ✓ Message input found")
                    
                    # Type hello world message
                    message_input.fill("Hello world! This is a test message from the E2E test suite.")
                    print("  ✓ Message typed")
                    
                    # Send with Ctrl+Enter
                    message_input.press("Control+Enter")
                    print("  ✓ Message sent (Ctrl+Enter)")
                    
                    # Wait for streaming response
                    print("  ⏳ Waiting for response (20s)...")
                    time.sleep(20)
                    
                else:
                    print("  ✗ Message input not found")
                    
            except Exception as e:
                print(f"  ⚠ Chat error: {e}")
            
            # Take screenshot after chat
            chat_screenshot = f"{SCREENSHOT_DIR}/04_chat_started_{timestamp()}.png"
            page.screenshot(path=chat_screenshot, full_page=True)
            print(f"  ✓ Screenshot saved: {chat_screenshot}")
            
            # Test slash commands
            print("\n[6/9] Testing slash commands...")
            
            slash_commands = ["/help", "/plan"]
            
            for cmd in slash_commands:
                try:
                    message_input = page.locator('textarea[placeholder*="Type a message"], textarea').first
                    
                    if message_input.count() > 0:
                        message_input.fill(cmd)
                        print(f"  ✓ Typed slash command: {cmd}")
                        message_input.press("Control+Enter")
                        print(f"  ⏳ Waiting for {cmd} response...")
                        time.sleep(8)
                        
                        # Screenshot for each command
                        cmd_screenshot = f"{SCREENSHOT_DIR}/05_slash_{cmd.replace('/', '')}_{timestamp()}.png"
                        page.screenshot(path=cmd_screenshot, full_page=True)
                        print(f"  ✓ Screenshot saved: {cmd_screenshot}")
                        
                        # Clear for next command
                        message_input.fill("")
                        
                except Exception as e:
                    print(f"  ⚠ Error testing {cmd}: {e}")
            
            # Test UI components - Settings
            print("\n[7/9] Testing UI components (Settings)...")
            
            try:
                # Click on the model indicator (Claude Sonnet) in status bar to open settings
                settings_btn = page.locator('button:has-text("Claude Sonnet"), button:has(.text-violet-400)').first
                if settings_btn.count() > 0:
                    settings_btn.click()
                    print("  ✓ Settings button clicked")
                    time.sleep(1)
                    
                    settings_screenshot = f"{SCREENSHOT_DIR}/06_settings_modal_{timestamp()}.png"
                    page.screenshot(path=settings_screenshot, full_page=True)
                    print(f"  ✓ Screenshot saved: {settings_screenshot}")
                    
                    # Close settings by clicking Cancel button
                    cancel_btn = page.locator('button:has-text("Cancel"), button:has-text("Close")').first
                    if cancel_btn.count() > 0:
                        cancel_btn.click()
                        print("  ✓ Settings Cancel button clicked")
                        # Wait for the modal overlay to be fully removed from DOM
                        page.wait_for_selector('.fixed.inset-0.bg-black\\/50', state='hidden', timeout=5000)
                        time.sleep(0.3)
                    else:
                        # Fallback to Escape key
                        page.press('body', 'Escape')
                        time.sleep(0.5)
                else:
                    print("  ⚠ Settings button not found")
            except Exception as e:
                print(f"  ⚠ Settings test error: {e}")
            
            # Test sidebar toggle
            print("\n[8/9] Testing sidebar toggle...")
            
            try:
                # Find sidebar toggle button (close sidebar)
                sidebar_toggle = page.locator('button[title="Close sidebar"]').first
                if sidebar_toggle.count() > 0:
                    sidebar_toggle.click()
                    print("  ✓ Sidebar closed")
                    time.sleep(1)
                    
                    sidebar_screenshot = f"{SCREENSHOT_DIR}/07_sidebar_closed_{timestamp()}.png"
                    page.screenshot(path=sidebar_screenshot, full_page=True)
                    print(f"  ✓ Screenshot saved: {sidebar_screenshot}")
                    
                    # Re-open sidebar
                    open_sidebar = page.locator('button[title="Open sidebar"]').first
                    if open_sidebar.count() > 0:
                        open_sidebar.click()
                        print("  ✓ Sidebar re-opened")
                        time.sleep(0.5)
                else:
                    print("  ⚠ Sidebar toggle not found")
            except Exception as e:
                print(f"  ⚠ Sidebar test error: {e}")
            
            # Capture final state
            print("\n[9/9] Capturing final state...")
            final_screenshot = f"{SCREENSHOT_DIR}/08_final_state_{timestamp()}.png"
            page.screenshot(path=final_screenshot, full_page=True)
            print(f"  ✓ Screenshot saved: {final_screenshot}")
            
            # Analyze results
            print("\n" + "="*60)
            print("Analysis & Diagnostics")
            print("="*60)
            
            # Check for WebSocket connection
            ws_logs = [log for log in console_logs if 'websocket' in log.lower() or 'ws' in log.lower()]
            error_logs = [log for log in console_logs if log.startswith('error')]
            
            if ws_logs:
                print(f"  WebSocket logs: {len(ws_logs)} entries")
                for log in ws_logs[:3]:
                    print(f"    - {log}")
            
            if error_logs:
                print(f"  ⚠ Console errors: {len(error_logs)}")
                for log in error_logs[:5]:
                    print(f"    - {log}")
            else:
                print("  ✓ No console errors detected")
            
            if page_errors:
                print(f"  ⚠ Page errors: {len(page_errors)}")
                for err in page_errors[:3]:
                    print(f"    - {err}")
            
            # Print summary
            print("\n" + "="*60)
            print("E2E Test Summary")
            print("="*60)
            print(f"Screenshots saved to: {SCREENSHOT_DIR}")
            print(f"Console logs: {len(console_logs)} entries")
            print(f"Page errors: {len(page_errors)} entries")
            print(f"Final URL: {page.url}")
            print(f"Page title: {page.title()}")
            print("="*60)
            print("✓ E2E test completed!")
            print("="*60)
            
        except Exception as e:
            print(f"\n✗ Test failed with error: {e}")
            import traceback
            traceback.print_exc()
            # Capture error state
            try:
                error_screenshot = f"{SCREENSHOT_DIR}/ERROR_state_{timestamp()}.png"
                page.screenshot(path=error_screenshot, full_page=True)
                print(f"  Error screenshot saved: {error_screenshot}")
            except:
                pass
            raise
            
        finally:
            browser.close()

if __name__ == "__main__":
    try:
        test_pi_web_ui()
        sys.exit(0)
    except Exception as e:
        print(f"\nTest execution failed: {e}")
        sys.exit(1)
