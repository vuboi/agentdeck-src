@echo off
rem Run cargo on Windows with VS 2022 BuildTools env, LLVM libclang and
rem bindgen include paths, so whisper-rs-sys gets a fresh bindings.rs.
rem Usage: scripts\win-cargo.cmd check -p <package>
rem Requires: VS 2022 BuildTools (C++ workload), LLVM at C:\Program Files\LLVM.
setlocal EnableDelayedExpansion
rem cmd truncates PATH at 8191 characters: keep the system folders at the front so they survive vcvars and tests.
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
rem Some tests start `sh -c` (runner, tail): take Git for Windows sh when it is not on PATH.
if exist "%ProgramFiles%\Git\bin\sh.exe" set "PATH=%PATH%;%ProgramFiles%\Git\bin"

set "VS18VCVARS=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set "VS17VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VS18VCVARS%" (
  set "VCVARS=%VS18VCVARS%"
  if not defined CMAKE_GENERATOR set "CMAKE_GENERATOR=Visual Studio 18 2026"
) else if exist "%VS17VCVARS%" (
  set "VCVARS=%VS17VCVARS%"
  if not defined CMAKE_GENERATOR set "CMAKE_GENERATOR=Visual Studio 17 2022"
) else (
  echo win-cargo: vcvars64.bat not found: "%VCVARS%" 1>&2
  exit /b 1
)
rem vcvars64 calls vswhere.exe from the VS Installer dir; put it on PATH first.
set "PATH=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%PATH%"
call "%VCVARS%" >nul || exit /b 1
rem Use rustup cargo directly, not the mise shim.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

if not defined LIBCLANG_PATH set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"

rem bindgen does not see MSVC headers by default: pass INCLUDE dirs as -isystem.
set "BINDGEN_EXTRA_CLANG_ARGS="
for %%I in ("%INCLUDE:;=" "%") do (
  if not "%%~I"=="" set "BINDGEN_EXTRA_CLANG_ARGS=!BINDGEN_EXTRA_CLANG_ARGS! -isystem \"%%~I\""
)

cargo %*
exit /b %ERRORLEVEL%
