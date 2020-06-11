// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/* istanbul ignore file */

export enum LogLevel {
    'none' = 0,
    'info' = 10,
    'warn' = 20,
    'error' = 30,
    'debug' = 40,
}

export default class Logger {
    constructor(private logLevel: LogLevel) {}

    private jsonify(args: any[]) {
        return args.map((arg: any) => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg);
                } catch {
                    return arg;
                }
            }
            return arg;
        });
    }
    public info(...args: any) {
        if (this.logLevel >= LogLevel.info) {
            console.log(...this.jsonify(args));
        }
    }
    public warn(...args: any) {
        if (this.logLevel >= LogLevel.warn) {
            console.warn(...this.jsonify(args));
        }
    }
    public error(...args: any) {
        if (this.logLevel >= LogLevel.error) {
            console.error(...this.jsonify(args));
        }
    }
    public debug(...args: any) {
        if (this.logLevel >= LogLevel.debug) {
            console.trace(...this.jsonify(args));
        }
    }
}
