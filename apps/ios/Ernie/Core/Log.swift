import os

enum Log {
    static let net = Logger(subsystem: "com.websdbm.ernie", category: "net")
    static let chat = Logger(subsystem: "com.websdbm.ernie", category: "chat")
    static let speech = Logger(subsystem: "com.websdbm.ernie", category: "speech")
    static let push = Logger(subsystem: "com.websdbm.ernie", category: "push")
}
