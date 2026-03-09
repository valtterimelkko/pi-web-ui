#!/usr/bin/env python3
"""
Server lifecycle management helper for Playwright testing.
Starts servers, waits for them to be ready, runs tests, then cleans up.
"""

import argparse
import subprocess
import sys
import time
import socket
import signal
import os
from typing import List, Tuple


def is_port_open(port: int, host: str = "localhost") -> bool:
    """Check if a port is open and accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def wait_for_port(port: int, timeout: float = 60.0, host: str = "localhost") -> bool:
    """Wait for a port to become available."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        if is_port_open(port, host):
            return True
        time.sleep(0.5)
    return False


def start_server(command: str, port: int) -> subprocess.Popen:
    """Start a server process."""
    print(f"Starting server on port {port}: {command}")
    process = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=os.setsid if hasattr(os, 'setsid') else None
    )
    return process


def kill_process(process: subprocess.Popen):
    """Kill a process and its children."""
    try:
        if hasattr(os, 'killpg'):
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            if hasattr(os, 'killpg'):
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass


def main():
    parser = argparse.ArgumentParser(description='Manage servers for testing')
    parser.add_argument('--server', action='append', dest='commands', help='Server command to run')
    parser.add_argument('--port', action='append', type=int, dest='ports', help='Port to wait for')
    parser.add_argument('--wait', type=float, default=2.0, help='Additional wait time after ports are ready')
    parser.add_argument('remaining', nargs='*', help='Command to run after servers are ready')
    
    args = parser.parse_args()
    
    if not args.commands or not args.ports:
        print("Error: At least one --server and --port required", file=sys.stderr)
        sys.exit(1)
    
    if len(args.commands) != len(args.ports):
        print("Error: Number of --server and --port arguments must match", file=sys.stderr)
        sys.exit(1)
    
    processes: List[subprocess.Popen] = []
    
    try:
        # Start all servers
        for cmd, port in zip(args.commands, args.ports):
            proc = start_server(cmd, port)
            processes.append(proc)
        
        # Wait for all ports to be ready
        print("\nWaiting for servers to be ready...")
        for port in args.ports:
            if not wait_for_port(port, timeout=60.0):
                print(f"Error: Server on port {port} did not start in time", file=sys.stderr)
                sys.exit(1)
            print(f"  ✓ Port {port} is ready")
        
        # Additional wait time for initialization
        if args.wait > 0:
            print(f"\nWaiting {args.wait}s for initialization...")
            time.sleep(args.wait)
        
        print("\n" + "="*50)
        print("Servers are ready! Running test command...")
        print("="*50 + "\n")
        
        # Run the test command
        if args.remaining:
            # Join remaining args, handling the '--' separator
            cmd = ' '.join(args.remaining)
            result = subprocess.run(cmd, shell=True)
            sys.exit(result.returncode)
        else:
            print("No command specified. Servers are running.")
            print("Press Ctrl+C to stop.")
            while True:
                time.sleep(1)
                
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
    finally:
        print("\n" + "="*50)
        print("Shutting down servers...")
        print("="*50)
        for proc in processes:
            kill_process(proc)
        print("Servers stopped.")


if __name__ == '__main__':
    main()
