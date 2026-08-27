# Sessions are stored in home directory ~/redwake/agent/sessions

# in that sessions folder is a subdirectory for each application directory redwake agent was initialized in.

#  in each of those subdirectories is a jsonl file named session with a numbered id. This session file has a message object per line. when there is a new message in a conversation the message is simply appended. each  message is its own json object.

# each of those json object messages contains not only role: and message: but also a parent: and id:. The parent: field is the id of the message that came before it. One message can be the parent of multiple other messages. This creates a tree structure which best handles forked message histories.