#!/bin/bash
# Run after publishing @gatesai/providers@0.1.2
cd /home/lucian/gates
npm install @gatesai/providers@0.1.2
npm install -g . --force
echo "gates updated with OAuth subscription support"
